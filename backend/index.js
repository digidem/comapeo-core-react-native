import { fileURLToPath } from "node:url";
import os from "node:os";
import fs from "node:fs";
import Fastify from "fastify";

import { ComapeoRpcServer } from "./lib/comapeo-rpc.js";
import { createComapeo } from "./lib/create-comapeo.js";
import { SimpleRpcServer } from "./lib/simple-rpc.js";

// loader.mjs stashes the live `@sentry/node` namespace + config on
// globalThis when a DSN is present. Reading from globalThis (instead
// of statically importing `@sentry/node`) keeps the rollup chunk
// unloaded for consumers without Sentry.
/** @type {any} */
const Sentry = /** @type {any} */ (globalThis).__comapeoSentry ?? null;
/** @type {{ rpcArgsBytes: number, captureApplicationData: boolean } | null} */
const sentryConfig =
  /** @type {any} */ (globalThis).__comapeoSentryConfig ?? null;

// Resolved relative to this file at evaluation time. The drizzle
// migrations directory is kept alongside the bundle by
// `KEEP_THESE_FROM_BACKEND` in `scripts/build-backend.ts` so this path
// is valid both at npm-install time and inside the staged
// `nodejs-project/` resource tree on device.
const MIGRATIONS_FOLDER_PATH = fileURLToPath(
  new URL("./node_modules/@comapeo/core/drizzle", import.meta.url),
);

console.log("Starting Comapeo Node server...");

const [comapeoSocketPath, controlSocketPath, privateStorageDir] =
  process.argv.slice(2);

const fastify = Fastify();

// `MapeoManager` cannot exist until native sends the rootKey on the control
// socket. Hold the comapeo RPC server in a closure so the shutdown handler
// can close it if it ever got built, while staying a no-op if shutdown lands
// before init.
/** @type {ComapeoRpcServer | undefined} */
let comapeoRpcServer;
/** @type {Awaited<ReturnType<typeof createComapeo>> | undefined} */
let comapeo;

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
   * Receive the 16-byte rootKey from native and unblock manager construction.
   *
   * The first valid `init` resolves `initPromise`. Subsequent inits are
   * rejected with a warning so a misbehaving native side cannot reset the
   * manager mid-session. A malformed payload (non-string `rootKey`, bad
   * base64, or wrong length after decode) rejects `initPromise` once,
   * which surfaces to native as the process exiting non-zero — native then
   * transitions to its `error` state.
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
    // Strict base64 shape check. `Buffer.from(s, "base64")` is
    // permissive — invalid characters are silently dropped, so a
    // tampered string could still decode to 16 bytes that aren't the
    // bytes the producer encoded. Both Android (`Base64.NO_WRAP`) and
    // iOS (`base64EncodedString()`) emit standard base64 with `=`
    // padding; for a 16-byte input that's exactly 22 base64 chars
    // followed by `==`. Anything else is malformed.
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
      // Belt-and-braces: regex matched but decoded to wrong length.
      // Shouldn't be reachable given the regex, but the check is
      // free and the consequence of a bad rootKey is identity loss.
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
    // Announce graceful shutdown BEFORE closing anything. Native peers
    // (FGS-side and main-app-side on Android) use the presence of this
    // frame to distinguish "expected disconnect" from "unexpected
    // disconnect" — a control socket that closes without a preceding
    // `stopping` frame is unambiguously a crash or kill, not a graceful
    // exit. AF_UNIX is a stream socket; the kernel guarantees that the
    // 'stopping' frame is delivered before the EOF (socket close),
    // allowing the peer to distinguish graceful shutdown from a crash.
    controlIpcServer.broadcast({ type: "stopping" });
    const closePromises = [controlIpcServer.close(), fastify.close()];
    if (comapeoRpcServer) closePromises.push(comapeoRpcServer.close());
    await Promise.all(closePromises);
    if (comapeo) await comapeo.close();
  },
  /**
   * Cross-process error attribution channel (Android FGS → Node →
   * main-app process). When the FGS-side `NodeJSService` enters ERROR
   * from a *local* cause (rootkey load failure, startup watchdog
   * timeout) while Node is still alive, it sends this frame. The
   * backend re-broadcasts via `handleFatal` (which broadcasts the
   * `error` frame and exits 1 after a 100ms flush) so the main-app
   * process sees a real `error` frame with the correct phase and
   * message — not a generic "unexpected disconnect" inferred from a
   * sudden socket close.
   *
   * Without this channel, an FGS-side rootkey failure leaves Node
   * hanging on `await initPromise` (no backend timeout on init) while
   * the main-app process stays at STARTING forever. iOS doesn't use
   * this — in-process, the module reads service state directly.
   *
   * Validates the input: a misbehaving native side sending a
   * malformed payload is logged and ignored, not crashed on.
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
    // Tagged so handleFatal can mark the Sentry event source:native.
    const err = new Error(message.message);
    /** @type {Error & { source?: string }} */ (err).source = "native";
    handleFatal(message.phase, err);
  },
});

/**
 * Routes any startup failure or uncaught throw through a single exit
 * handler. Tagged with the boot `phase` so native (which receives the
 * frame on the control socket) can surface a precise error to the user.
 *
 * Centralising failure here means the boot IIFE below can stay
 * straight-line: each `await` either succeeds or throws, and the catch
 * funnels into the same broadcast-then-exit machinery as
 * `uncaughtException` / `unhandledRejection`.
 *
 * @param {string} phase
 * @param {unknown} error
 */
async function handleFatal(phase, error) {
  const err = error instanceof Error ? error : new Error(String(error));
  console.error(`Fatal during ${phase}:`, err);
  const isNativeForward =
    error != null &&
    typeof error === "object" &&
    /** @type {{ source?: unknown }} */ (error).source === "native";
  if (Sentry) {
    try {
      const deviceCtx = readDeviceMemoryAndStorage();
      Sentry.captureException(err, {
        tags: {
          phase,
          layer: "node",
          ...(isNativeForward ? { source: "native" } : {}),
        },
        ...(deviceCtx ? { contexts: { device: deviceCtx } } : {}),
      });
    } catch (captureErr) {
      console.error("Failed to capture Sentry event", captureErr);
    }
  }
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
  // 100ms covers the AF_UNIX kernel buffer flush; Sentry flushes in
  // parallel under the same cap.
  const flushPromise = Sentry
    ? Sentry.flush(100).catch(() => {})
    : Promise.resolve();
  await Promise.all([
    new Promise((resolve) => setTimeout(resolve, 100)),
    flushPromise,
  ]);
  process.exit(1);
}

// Async handlers are supported here. Node will not auto-exit while the
// handler's microtasks/timers are pending, so the broadcast above gets
// a chance to flush before our explicit `process.exit(1)`.
process.on("uncaughtException", (error) => {
  handleFatal("runtime", error);
});
process.on("unhandledRejection", (reason) => {
  handleFatal("runtime", reason);
});

/**
 * Best-effort system memory + private-storage snapshot for fatal
 * captures. `@sentry/node` doesn't synthesise device context the way
 * sentry-cocoa / sentry-android do, so OOM and disk-full crashes have
 * no `device.free_memory` / `device.free_storage` in the Sentry UI
 * without this. Field names match Sentry's standard device-context
 * schema so they render alongside the platform-side values.
 *
 * Returns null on any failure — we never let context probing block a
 * fatal capture.
 *
 * @returns {Record<string, number> | null}
 */
function readDeviceMemoryAndStorage() {
  try {
    /** @type {Record<string, number>} */
    const ctx = {
      memory_size: os.totalmem(),
      free_memory: os.freemem(),
    };
    try {
      const stats = fs.statfsSync(privateStorageDir);
      ctx.storage_size = stats.bsize * stats.blocks;
      ctx.free_storage = stats.bsize * stats.bavail;
    } catch {
      // statfs unsupported / path missing — omit storage fields only.
    }
    return ctx;
  } catch {
    return null;
  }
}

/**
 * Wraps a boot phase in a Sentry span when active. No-op when Sentry
 * isn't configured. Span ends with `internal_error` if the body throws.
 *
 * @template T
 * @param {string} name
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function bootSpan(name, fn) {
  if (!Sentry) return fn();
  // `op` matches `name` so Discover renders the phase identifier as
  // `span.name` (sentry-java/cocoa derive name from op for child
  // spans; @sentry/node's transactions take name from this field
  // directly). Filter all boot spans with `op:boot.*`.
  return Sentry.startSpan(
    { name, op: name },
    async (/** @type {any} */ span) => {
      try {
        const r = await fn();
        span?.setStatus?.({ code: 1, message: "ok" });
        return r;
      } catch (e) {
        span?.setStatus?.({ code: 2, message: "internal_error" });
        throw e;
      }
    },
  );
}

(async () => {
  try {
    // 1. Bind the control socket. Native is already polling for it; once
    // bound, the `started` broadcast tells native it can send the init frame.
    try {
      await bootSpan("boot.listen-control", () =>
        controlIpcServer.listen(controlSocketPath),
      );
    } catch (e) {
      throw Object.assign(e, { phase: "listen-control" });
    }
    console.log(`Control socket listening on ${controlSocketPath}`);

    // Wire the Sentry frame sink now that the socket is bound. The sink
    // is `null` in loader.mjs until this call lands — pre-listen frames
    // sit in a 100-element ring buffer in the loader and drain into
    // this sink on registration. `broadcast` falls back to its own
    // ring buffer when no clients are connected (see SimpleRpcServer),
    // so frames queued at startup are forwarded as soon as the FGS
    // (Android) or the in-process control IPC (iOS) connects.
    const setSink = /** @type {any} */ (globalThis).__comapeoSentrySetSink;
    if (typeof setSink === "function") {
      setSink(
        /** @param {{type: string} & import("type-fest").JsonObject} frame */
        (frame) => {
          controlIpcServer.broadcast(frame);
        },
      );
    }

    controlIpcServer.setReadinessPhase("started");

    // 2. Wait for native to send the rootKey. `initPromise` resolves on the
    // first valid init frame; rejects on a malformed one.
    let rootKey;
    try {
      rootKey = await initPromise;
    } catch (e) {
      throw Object.assign(e, { phase: "init" });
    }

    // 3. Construct the manager and bind the comapeo RPC socket.
    // boot.manager-init (stage D) wraps drizzle migrations + SQLite open
    // + hypercore/fastify init + RPC socket bind.
    try {
      await bootSpan("boot.manager-init", async () => {
        comapeo = createComapeo({
          privateStorageDir,
          fastify,
          migrationsFolderPath: MIGRATIONS_FOLDER_PATH,
          rootKey,
        });
        comapeoRpcServer = new ComapeoRpcServer(comapeo, {
          sentry: Sentry,
          rpcArgsBytes: sentryConfig?.rpcArgsBytes ?? 0,
        });
        await comapeoRpcServer.listen(comapeoSocketPath);
      });
    } catch (e) {
      throw Object.assign(e, { phase: "construct" });
    }
    console.log(`Comapeo socket listening on ${comapeoSocketPath}`);

    // 4. Announce ready. The settle-window-then-ready dance is gone now
    // that `ready` carries actual meaning (manager exists, RPC is safe).
    controlIpcServer.setReadinessPhase("ready");

    // TEMPORARY — remove before commit. Smoke-test hook: capture
    // a single Node-side event so we can verify the sentry-event
    // forwarding path works end-to-end.
    if (Sentry) {
      setTimeout(() => {
        Sentry.captureException(new Error("smoke: node-side forwarding test"));
      }, 2000);
    }
  } catch (error) {
    const phase =
      (error && typeof error === "object" && "phase" in error
        ? /** @type {{phase: string}} */ (error).phase
        : null) ?? "boot";
    handleFatal(phase, error);
  }
})();

process.on("exit", () => {
  console.log("node exiting");
});
