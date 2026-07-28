import { monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ensureError from "ensure-error";
import Fastify from "fastify";

import { ComapeoRpc } from "./lib/comapeo-rpc.js";
import { createComapeo } from "./lib/create-comapeo.js";
import { createMapServer } from "./lib/create-map-server.js";
import { SimpleRpcServer } from "./lib/simple-rpc.js";
import * as sentry from "./lib/sentry.js";
import * as metrics from "./lib/metrics.js";
import { observeSyncSessions } from "./lib/sync-observer.js";
import {
  checkShouldMigrate,
  migrateStorage,
  MIGRATION_REASON_NO_SPACE,
} from "@comapeo/core/migration.js";

// 60s sampler cadence for backend memory + uptime gauges. No-op
// when Sentry is off (the metrics layer never got its SDK).
const MEMORY_SAMPLE_INTERVAL_MS = 60_000;

// Shared/Android entry. Android's nodejs-mobile build ships the
// undici-backed `fetch`/`Response`/`Request` globals the map server needs;
// iOS lacks them and installs them first via `index.ios.js` → `install-fetch.js`.

// `KEEP_THESE_FROM_BACKEND` in `scripts/build-backend.ts` mirrors these
// directories into the on-device bundle.
const MIGRATIONS_FOLDER_PATH = fileURLToPath(
  new URL("./node_modules/@comapeo/core/drizzle", import.meta.url),
);
const OLD_MIGRATIONS_FOLDER_PATH = fileURLToPath(
  new URL("./node_modules/comapeo-core-old/drizzle", import.meta.url),
);

console.log("Starting Comapeo Node server...");

// 4th positional is an optional path to the default project config
// (presets/categories) the consuming app bundles via the Expo plugin.
// 5th positional is an optional online map style URL the consuming app
// sets via the Expo plugin. Native always passes both slots (empty
// string when unset) so the `--sentry*` flags that follow can't land in
// them. Empty 4th → undefined → MapeoManager applies no default config;
// empty 5th → undefined → createComapeo falls back to its built-in URL.
// 6th positional is available disk space (bytes) for migration decision.
// Native always passes this slot ("0" when unknown).
const [
  comapeoSocketPath,
  controlSocketPath,
  privateStorageDir,
  configArg,
  styleUrlArg,
  availableDiskSpaceArg,
] = process.argv.slice(2);
const defaultConfigPath = configArg || undefined;
const defaultOnlineStyleUrl = styleUrlArg || undefined;
const availableDiskSpace =
  availableDiskSpaceArg !== undefined
    ? Number(availableDiskSpaceArg)
    : undefined;

const fastify = Fastify();

// Manager construction is gated on native sending the rootKey; hold
// these so shutdown can close them if construction succeeded.
/** @type {ComapeoRpc | undefined} */
let comapeoRpcServer;
/** @type {import("@comapeo/core").MapeoManager | undefined} */
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

/**
 * One-shot retry gate: resolves on first `retry` frame from native.
 * Only fires once so a misbehaving native side can't loop the boot.
 * Declared at module scope so the SimpleRpcServer `retry` handler can
 * reference it; the boot IIFE awaits the promise.
 */
/** @type {(() => void) | undefined} */
let resolveRetry;
const retryPromise = new Promise((resolve) => {
  resolveRetry = () => {
    resolve();
    resolveRetry = undefined;
  };
});
let retryConsumed = false;

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
    // withSpan records each phase to `comapeo.shutdown.phase_duration_ms`
    // even when traces are off, mirroring the boot phases.
    await sentry.withSpan("shutdown.close-servers", () =>
      Promise.all([
        settle("control", controlIpcServer.close()),
        settle("fastify", fastify.close()),
        ...(comapeoRpcServer ? [settle("rpc", comapeoRpcServer.close())] : []),
      ]),
    );
    if (comapeoManager) {
      await sentry.withSpan("shutdown.close-manager", () =>
        settle("manager", comapeoManager.close()),
      );
    }
    if (mapServer) {
      await sentry.withSpan("shutdown.close-map-server", () =>
        settle("map-server", mapServer.close()),
      );
    }
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
  /**
   * Resumes the boot after a low-space pause. Native sends this after the
   * host app surfaces the `low-space` event and the user acts (frees space,
   * accepts fallback). Only the first retry is honoured; subsequent retries
   * are no-ops so a misbehaving native side can't loop the boot.
   */
  retry: () => {
    if (retryConsumed) {
      console.warn("Received retry after boot already resumed; ignoring");
      return;
    }
    retryConsumed = true;
    resolveRetry?.();
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

    // ---- Migration (retryable on low-space) ----

    const coreStorageDir = path.join(privateStorageDir, "core-storage");

    /**
     * Run migration check + execute if needed.
     * @param {boolean} forceFallback When true and disk is full, skip migration
     *   and use the old MapeoManager version instead of throwing.
     * @returns {Promise<{ useFallback: boolean }>}
     */
    async function runMigration(forceFallback) {
      if (forceFallback) {
        return { useFallback: true }
      }
      const { shouldUpgrade, useFallback, reason, spaceNeeded } = await withPhase(
        "migrate-check",
        () => checkShouldMigrate(coreStorageDir, availableDiskSpace),
      );

      if (reason === MIGRATION_REASON_NO_SPACE) {
        if (forceFallback) {
          console.warn(
            "No space for migration, falling back to old manager",
          );
          return { useFallback: true };
        }
        throw Object.assign(new Error("No disk space for migration"), {
          __lowSpace: true,
          spaceNeeded,
        });
      }

      if (shouldUpgrade) {
        controlIpcServer.broadcast({ type: "migrating" });
        /** @type {Record<string, { migrated: boolean; error?: Error }> | undefined} */
        const migrationResults = await withPhase("migrate", () =>
          migrateStorage(coreStorageDir, (doneSoFar, totalCores) => {
            controlIpcServer.broadcast({
              type: "migrating",
              progress: `${doneSoFar}/${totalCores}`,
            });
          }),
        );

        // migrateStorage catches per-project errors in the result map.
        if (migrationResults) {
          /** @type {Error | undefined} */
          let firstError;
          for (const [projectId, result] of Object.entries(migrationResults)) {
            if (!result.migrated && result.error) {
              console.error(
                `Migration failed for project ${projectId}:`,
                result.error,
              );
              firstError ??= result.error;
            }
          }
          if (firstError) {
            /** @type {Error & { source?: string }} */ (firstError).source =
              "migrate-storage";
            throw firstError;
          }
        }
      }

      return { useFallback };
    }

    // Run migration; on low-space broadcast event, wait for retry, then retry with fallback.
    let migrationUseFallback = false;
    try {
      const result = await runMigration(false);
      migrationUseFallback = result.useFallback;
    } catch (error) {
      if (error && typeof error === "object" && "__lowSpace" in error && error.__lowSpace) {
        controlIpcServer.broadcast({ type: "low-space", spaceNeeded: error.spaceNeeded });
        // Park until native sends `retry` (e.g. after user frees space or
        // accepts fallback). Event loop stays alive — Node won't exit.
        await retryPromise;
        const result = await runMigration(true);
        migrationUseFallback = result.useFallback;
      } else {
        throw error;
      }
    }

    // ---- Construct manager ----

    // Dashboard label (`boot.manager-init`) vs. wire phase (`construct`)
    // used by native error frames.
    await withPhase("construct", () =>
      sentry.withSpan("boot.manager-init", async () => {
        // Old and new MapeoManager have incompatible #private fields; cast
        // to the newer type. Both share the same public API surface.
        comapeoManager = /** @type {import("@comapeo/core").MapeoManager} */ (
          createComapeo({
            privateStorageDir,
            fastify,
            migrationsFolderPath: MIGRATIONS_FOLDER_PATH,
            oldMigrationsFolderPath: OLD_MIGRATIONS_FOLDER_PATH,
            defaultConfigPath,
            defaultOnlineStyleUrl,
            rootKey,
            useFallback: migrationUseFallback,
          })
        );

        observeSyncSessions(comapeoManager);

        // Start the MapeoManager's Fastify so its blob/icon server is
        // reachable. `$blobs.getUrl()` / `$icons.getUrl()` await the server's
        // address (5s timeout, else AbortError). Non-fatal: surface listen
        // failures to getUrl() callers only.
        fastify.listen({ host: "127.0.0.1", port: 0 }).catch(() => {});

        // Map server is non-critical: boot must still reach "ready" if it
        // fails. Isolate construction *and* listen() inside one promise so any
        // failure — a synchronous createMapServer() throw included — surfaces
        // only to getBaseUrl() callers, never aborting the manager's boot or
        // tripping the global unhandledRejection handler (which exits).
        const mapServerListenPromise = Promise.resolve().then(() => {
          mapServer = createMapServer({
            privateStorageDir,
            rootKey,
            defaultOnlineStyleUrl,
          });
          return mapServer.listen();
        });
        mapServerListenPromise.catch((err) => {
          sentry.captureFatal(
            "map-server-init",
            ensureError(err),
            "create-map-server",
          );
        });
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
    metrics.bootOutcome("started");
    startMemorySampler();
    sampleStorageSize(privateStorageDir);
  } catch (error) {
    const phase = getStringProp(error, "phase") || "boot";
    metrics.bootOutcome("error", phase);
    handleFatal(phase, error);
  }
})();

/**
 * 60s sampler for backend heap + event-loop delay. `unref()` so the timer
 * never keeps the process alive past shutdown. No-op when Sentry is off —
 * everything it does is emit metrics, so skip the timer entirely rather than
 * firing a perpetual no-op wakeup.
 *
 * Event-loop delay comes from `monitorEventLoopDelay` (a real high-res
 * histogram). We report the window **max** — the worst single stall in the
 * interval — because that's what surfaces a stall; the mean buried a brief
 * 800ms stall in ~6000 samples. Reset each tick so windows are independent.
 * `monitorEventLoopDelay` is pure libuv (no native addon / worker / inspector),
 * so it works in nodejs-mobile; and because its own sampling timer freezes when
 * iOS suspends the app, a background suspension is correctly NOT counted as delay.
 */
function startMemorySampler() {
  if (!metrics.isEnabled()) return;
  const eld = monitorEventLoopDelay({ resolution: 10 });
  eld.enable();
  const timer = setInterval(() => {
    metrics.backendMemorySample();
    metrics.eventLoopDelaySample(eld.max / 1e6);
    eld.reset();
  }, MEMORY_SAMPLE_INTERVAL_MS);
  timer.unref?.();
}

/**
 * One-shot bucketed storage-size counter at STARTED. Reads the
 * private storage dir recursively; best-effort — a stat error skips the
 * sample rather than failing boot.
 *
 * @param {string | undefined} dir
 */
function sampleStorageSize(dir) {
  if (!dir) return;
  // The recursive stat-walk below is only worth running if its bucket
  // metric will actually be recorded; skip it entirely when Sentry is off.
  if (!metrics.isEnabled()) return;
  import("node:fs")
    .then(async ({ promises: fs }) => {
      let total = 0;
      /** @param {string} path */
      const walk = async (path) => {
        const entries = await fs.readdir(path, { withFileTypes: true });
        for (const entry of entries) {
          const full = `${path}/${entry.name}`;
          if (entry.isDirectory()) {
            await walk(full);
          } else {
            try {
              total += (await fs.stat(full)).size;
            } catch {
              // Vanished mid-walk — skip.
            }
          }
        }
      };
      await walk(dir);
      metrics.storageSizeBucket(metrics.storageBucket(total));
    })
    .catch(() => {});
}

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
