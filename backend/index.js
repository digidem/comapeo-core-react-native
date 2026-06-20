import { fileURLToPath } from "node:url";
import ensureError from "ensure-error";
import Fastify from "fastify";

import { ComapeoRpc } from "./lib/comapeo-rpc.js";
import { createComapeo } from "./lib/create-comapeo.js";
import { createMapServer } from "./lib/create-map-server.js";
import { SimpleRpcServer } from "./lib/simple-rpc.js";
import * as sentry from "./lib/sentry.js";

// Shared/Android entry. Android's nodejs-mobile build ships the
// undici-backed `fetch`/`Response`/`Request` globals the map server needs;
// iOS lacks them and installs them first via `index.ios.js` → `install-fetch.js`.

// `KEEP_THESE_FROM_BACKEND` in `scripts/build-backend.ts` mirrors this
// directory into the on-device bundle.
const MIGRATIONS_FOLDER_PATH = fileURLToPath(
  new URL("./node_modules/@comapeo/core/drizzle", import.meta.url),
);

console.log("Starting Comapeo Node server...");

// 4th positional is an optional path to the default project config
// (presets/categories) the consuming app bundles via the Expo plugin.
// Native always passes the slot (empty string when none) so the
// `--sentry*` flags that follow can't land in it. Empty → undefined →
// MapeoManager applies no default config to new projects.
const [comapeoSocketPath, controlSocketPath, privateStorageDir, configArg] =
  process.argv.slice(2);
const defaultConfigPath = configArg || undefined;

const fastify = Fastify();

// Manager construction is gated on native sending the rootKey; hold
// these so shutdown can close them if construction succeeded.
/** @type {ComapeoRpc | undefined} */
let comapeoRpcServer;
/** @type {Awaited<ReturnType<typeof createComapeo>> | undefined} */
let comapeoManager;
/** @type {Awaited<ReturnType<typeof createMapServer>> | undefined} */
let mapServer;

/** @type {(rootKey: Buffer) => void} */
let resolveInit;
/** @type {(reason: Error) => void} */
let rejectInit;
/** @type {Promise<Buffer>} */
const initPromise = new Promise((resolve, reject) => {
  resolveInit = resolve;
  rejectInit = reject;
});
let initConsumed = false;

const controlIpcServer = new SimpleRpcServer({
  /**
   * First valid init resolves `initPromise`; subsequent inits ignore
   * (so a misbehaving native side can't reset the manager mid-session).
   * Malformed payload rejects once → process exits → native enters ERROR.
   *
   * @param {Record<string, unknown>} message
   */
  init: (message) => {
    if (initConsumed) {
      console.warn("Received init after manager was created; ignoring");
      return;
    }
    if (typeof message.rootKey !== "string") {
      rejectInit(
        new Error(
          `init.rootKey must be a base64 string, got ${typeof message.rootKey}`,
        ),
      );
      initConsumed = true;
      return;
    }
    // `Buffer.from(s, "base64")` silently drops invalid chars, so a
    // tampered string can still decode to 16 unrelated bytes. Both
    // platforms emit standard base64; 16 bytes = 22 chars + "==".
    if (!/^[A-Za-z0-9+/]{22}==$/.test(message.rootKey)) {
      rejectInit(
        new Error(
          `init.rootKey is not strict-base64 of 16 bytes (expected ` +
            `/^[A-Za-z0-9+/]{22}==$/, got ${message.rootKey.length} chars)`,
        ),
      );
      initConsumed = true;
      return;
    }
    const rootKey = Buffer.from(message.rootKey, "base64");
    if (rootKey.byteLength !== 16) {
      rejectInit(
        new Error(
          `init.rootKey must decode to 16 bytes, got ${rootKey.byteLength}`,
        ),
      );
      initConsumed = true;
      return;
    }
    initConsumed = true;
    resolveInit(rootKey);
  },
  shutdown: async () => {
    // Broadcast BEFORE close: AF_UNIX guarantees this frame reaches
    // peers before EOF, so they can tell graceful shutdown from a crash.
    controlIpcServer.broadcast({ type: "stopping" });
    // Each close is isolated so one failure can't leak the others.
    /**
     * @param {string} label
     * @param {Promise<unknown>} p
     */
    const settle = (label, p) =>
      Promise.resolve(p).catch((e) =>
        console.error(`shutdown: ${label} close failed`, e),
      );
    await Promise.all([
      settle("control", controlIpcServer.close()),
      settle("fastify", fastify.close()),
      ...(comapeoRpcServer ? [settle("rpc", comapeoRpcServer.close())] : []),
    ]);
    if (comapeoManager) await settle("manager", comapeoManager.close());
    if (mapServer) await settle("map-server", mapServer.close());
  },
  /**
   * Android-only attribution channel: FGS-local failures (rootkey load,
   * startup watchdog) send this so the main-app process gets a real
   * `error` frame instead of inferring "unexpected disconnect" from a
   * socket close. iOS reads service state directly in-process.
   *
   * @param {Record<string, unknown>} message
   */
  "error-native": (message) => {
    if (
      typeof message.phase !== "string" ||
      typeof message.message !== "string"
    ) {
      console.warn("Received malformed error-native frame, ignoring", message);
      return;
    }
    const err = new Error(message.message);
    /** @type {Error & { source?: string }} */ (err).source = "native";
    handleFatal(message.phase, err);
  },
});

/**
 * Single exit handler for startup/runtime failures: tag the Sentry
 * event with `phase`, broadcast to native, flush, exit. Keeps the boot
 * IIFE straight-line.
 *
 * @param {string} phase
 * @param {unknown} error
 */
async function handleFatal(phase, error) {
  const err = ensureError(error);
  console.error(`Fatal during ${phase}:`, err);
  const source = getStringProp(err, "source") || "unknown";
  sentry.captureFatal(phase, err, source);
  try {
    controlIpcServer.broadcast({
      type: "error",
      phase,
      message: err.message,
      stack: err.stack,
    });
  } catch (broadcastErr) {
    console.error("Failed to broadcast error frame", broadcastErr);
  }
  // 100ms covers AF_UNIX flush; Sentry flushes in parallel.
  await Promise.all([
    sentry.flush(100),
    new Promise((resolve) => setTimeout(resolve, 100)),
  ]);
  process.exit(1);
}

// Async handlers OK: Node waits on pending microtasks/timers before exit.
process.on("uncaughtException", (error) => {
  handleFatal("runtime", error);
});
process.on("unhandledRejection", (reason) => {
  handleFatal("runtime", reason);
});

/**
 * Tag a thrown error with `.phase` (non-enumerable) for `handleFatal`
 * attribution. Sentry-agnostic — works in the no-DSN path.
 *
 * @template T
 * @param {string} phase
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withPhase(phase, fn) {
  try {
    return await fn();
  } catch (e) {
    const err = ensureError(e);
    Object.defineProperty(err, "phase", {
      value: phase,
      enumerable: false,
      configurable: true,
    });
    throw err;
  }
}

(async () => {
  try {
    await withPhase("listen-control", () =>
      controlIpcServer.listen(controlSocketPath),
    );
    console.log(`Control socket listening on ${controlSocketPath}`);

    // Drain loader.mjs's pre-listen queue; SimpleRpcServer's own ring
    // buffer covers the gap until clients connect.
    sentry.setSink((frame) => controlIpcServer.broadcast(frame));

    controlIpcServer.setReadinessPhase("started");

    // No span: native already measures `boot.rootkey-load` on the
    // same trace; a duplicate would only add noise.
    const rootKey = await withPhase("init", () => initPromise);

    // Dashboard label (`boot.manager-init`) vs. wire phase (`construct`)
    // used by native error frames.
    await withPhase("construct", () =>
      sentry.withSpan("boot.manager-init", async () => {
        comapeoManager = createComapeo({
          privateStorageDir,
          fastify,
          migrationsFolderPath: MIGRATIONS_FOLDER_PATH,
          defaultConfigPath,
          rootKey,
        });

        mapServer = createMapServer({ privateStorageDir, rootKey });
        // Map server is non-critical: boot still reaches "ready" if it fails.
        // Attach a no-op catch so a listen() rejection surfaces only to
        // getBaseUrl() callers and never trips the global unhandledRejection
        // handler (which exits the process).
        const mapServerListenPromise = mapServer.listen();
        mapServerListenPromise.catch(() => {});
        /** @type {import("@comapeo/ipc/server.js").ComapeoServicesApi} */
        const comapeoServices = {
          mapServer: {
            async getBaseUrl() {
              const { localPort } = await mapServerListenPromise;
              return `http://127.0.0.1:${localPort}`;
            },
          },
        };

        comapeoRpcServer = new ComapeoRpc(
          { comapeoManager, comapeoServices },
          { onRequestHook: sentry.rpcHook() },
        );

        await comapeoRpcServer.listen(comapeoSocketPath);
      }),
    );
    console.log(`Comapeo socket listening on ${comapeoSocketPath}`);

    controlIpcServer.setReadinessPhase("ready");
  } catch (error) {
    const phase = getStringProp(error, "phase") || "boot";
    handleFatal(phase, error);
  }
})();

process.on("exit", () => {
  console.log("node exiting");
});

/**
 * @param {unknown} e
 * @param {string} prop
 */
function getStringProp(e, prop) {
  const value = /** @type {any} */ (e)?.[prop];
  return typeof value === "string" ? value : undefined;
}
