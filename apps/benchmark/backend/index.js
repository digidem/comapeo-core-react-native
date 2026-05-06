import { BenchRpcServer } from "./lib/bench-rpc.js";
import { startBootSpan } from "./lib/boot-spans.js";
// Path-imported from the module's production backend so the bench
// bundle exercises the same control-socket framing as production —
// rollup inlines this at bundle time. Out-of-tree imports for shared
// helpers are intentional: any divergence here would invalidate the
// benchmark's whole premise.
import { SimpleRpcServer } from "../../../backend/lib/simple-rpc.js";
import { createSinkFromArg } from "./lib/telemetry-sink.js";

/**
 * Bench-only nodejs-mobile entry. Identical state-machine shape to the
 * production `backend/index.js` (so the native loader is unchanged: same
 * positional args, same `started` / `ready` broadcasts on the control
 * socket, same `stopping` / `error` lifecycle frames) but with two
 * substitutions that isolate the bridge under test from `@comapeo/core`:
 *
 *   1. Init validation is relaxed. The production handler enforces a
 *      strict-base64 16-byte rootKey; here we accept any non-empty
 *      `init` frame so the bench app can use a fixed dummy rootKey
 *      without re-implementing the encoding rules.
 *   2. The comapeo-RPC socket runs `BenchRpcServer` (echo + payload
 *      methods) instead of `ComapeoRpcServer` (the full MapeoManager
 *      surface). `@comapeo/core` is therefore not imported and the
 *      rolled-up bundle excludes its drizzle migrations, sqlite addon,
 *      undici, etc. — exactly the noise we want to drop.
 *
 * Boot phases (`listen-control`, `init`, `construct`) are wrapped with
 * `startBootSpan` so the same Sentry-shaped taxonomy from §7.4.2 of the
 * Sentry plan emits to whichever sink the host configured. The three
 * native-side phases (`ipc-connect (control)`, `rootkey-load`,
 * `ipc-connect (comapeo)`) stay native-side; they're added by the
 * Sentry plan when production loaders adopt shared instrumentation.
 */

console.log("Starting Comapeo Node BENCHMARK server...");

// privateStorageDir (3rd positional arg) is consumed by the production
// backend for sqlite + file resources; the bench backend doesn't touch
// disk at the application layer, so it's deliberately unread here.
const [comapeoSocketPath, controlSocketPath, , ...rest] =
  process.argv.slice(2);

// `--telemetry=<spec>` selects the sink. See `createSinkFromArg` for
// supported forms. Unspecified → NoopSink, which is the right default
// for a "production-like" run where we want zero tracing overhead.
const telemetryArg = rest.find((a) => a.startsWith("--telemetry="));
// `--device=<tag>` is set by the native loader (see
// android/src/main/java/com/comapeo/core/NodeJSService.kt) so backend
// span emissions can carry device attribution without a round-trip
// through RN. Falls back to `unknown` when the loader didn't set it
// (production loader, or an iOS path that hasn't been wired yet).
const deviceArg = rest.find((a) => a.startsWith("--device="));
const deviceTag = deviceArg ? deviceArg.slice("--device=".length) : "unknown";
// Per-process session id; lets the receiver group every span this
// process emits (boot.* and rpc.*) into one NDJSON file. The RN side
// generates its own runId per Run-benchmark tap; both end up tagged
// with the same `attrs.device`, so the summarizer can re-correlate
// across files post-hoc.
const sessionRunId = `boot-${Date.now().toString(36)}-${Math.random()
  .toString(36)
  .slice(2, 8)}`;
const sink = createSinkFromArg(
  telemetryArg ? telemetryArg.slice("--telemetry=".length) : undefined,
  { runId: sessionRunId, device: deviceTag },
);

/** @type {BenchRpcServer | undefined} */
let benchRpcServer;
/**
 * Set true once a graceful shutdown has been initiated. Used by the
 * `uncaughtException` filter below to distinguish a shutdown-race
 * write-after-end (benign — the peer is going away) from a real
 * runtime fault that should tear the process down.
 */
let isShuttingDown = false;

/** @type {(rootKey: unknown) => void} */
let resolveInit;
/** @type {(reason: Error) => void} */
let rejectInit;
/** @type {Promise<unknown>} */
const initPromise = new Promise((resolve, reject) => {
  resolveInit = resolve;
  rejectInit = reject;
});
let initConsumed = false;

const controlIpcServer = new SimpleRpcServer({
  /**
   * Bench init: relaxed shape check. Accepts any object payload —
   * native passes a base64 rootKey string just like in production but
   * the bench backend doesn't construct a MapeoManager so the bytes
   * are never used. Rejecting on missing payload still surfaces a
   * malformed native loader.
   *
   * @param {Record<string, unknown>} message
   */
  init: (message) => {
    if (initConsumed) {
      console.warn("Bench: received init after manager construction; ignoring");
      return;
    }
    initConsumed = true;
    if (!message || typeof message !== "object") {
      rejectInit(new Error("Bench init: malformed message"));
      return;
    }
    resolveInit(message.rootKey ?? null);
  },
  shutdown: async () => {
    isShuttingDown = true;
    // Match production's shutdown frame ordering so native lifecycle
    // detection (graceful exit vs. crash) keeps working unchanged.
    controlIpcServer.broadcast({ type: "stopping" });
    /** @type {Promise<void>[]} */
    const closePromises = [controlIpcServer.close()];
    if (benchRpcServer) closePromises.push(benchRpcServer.close());
    await Promise.all(closePromises);
    await sink.close();
  },
  /** @param {Record<string, unknown>} message */
  "error-native": (message) => {
    if (
      typeof message.phase !== "string" ||
      typeof message.message !== "string"
    ) {
      console.warn("Bench: malformed error-native frame, ignoring", message);
      return;
    }
    handleFatal(message.phase, new Error(message.message));
  },
});

/**
 * @param {string} phase
 * @param {unknown} error
 */
async function handleFatal(phase, error) {
  const err = error instanceof Error ? error : new Error(String(error));
  console.error(`Bench: fatal during ${phase}:`, err);
  try {
    controlIpcServer.broadcastError({
      phase,
      message: err.message,
      stack: err.stack,
    });
  } catch (broadcastErr) {
    console.error("Bench: failed to broadcast error frame", broadcastErr);
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  process.exit(1);
}

/**
 * Filter for the streamx-microtask shutdown race described above.
 *
 * Returns true if `e` is an `ERR_STREAM_WRITE_AFTER_END` thrown while
 * a graceful shutdown is in progress — benign by definition (the
 * message was already destined for a peer being torn down). Returned
 * to both `uncaughtException` and `unhandledRejection` because Node's
 * internal writable surfaces this error via either path depending on
 * which microtask boundary it crosses.
 *
 * @param {unknown} e
 */
function isBenignShutdownWriteAfterEnd(e) {
  return (
    isShuttingDown &&
    !!e &&
    typeof e === "object" &&
    "code" in e &&
    /** @type {NodeJS.ErrnoException} */ (e).code === "ERR_STREAM_WRITE_AFTER_END"
  );
}

process.on("uncaughtException", (error) => {
  if (isBenignShutdownWriteAfterEnd(error)) {
    console.warn("Bench: uncaught write-after-end during shutdown, ignored");
    return;
  }
  handleFatal("runtime", error);
});
process.on("unhandledRejection", (reason) => {
  if (isBenignShutdownWriteAfterEnd(reason)) {
    console.warn("Bench: unhandled-rejection write-after-end during shutdown, ignored");
    return;
  }
  handleFatal("runtime", reason);
});

(async () => {
  try {
    // 1. Bind the control socket. Native is already polling for it.
    const listenSpan = startBootSpan(sink, "listen-control");
    try {
      await controlIpcServer.listen(controlSocketPath);
    } catch (e) {
      throw Object.assign(
        e instanceof Error ? e : new Error(String(e)),
        { phase: "listen-control" },
      );
    } finally {
      listenSpan.end();
    }
    console.log(`Bench control socket listening on ${controlSocketPath}`);
    controlIpcServer.setReadinessPhase("started");

    // 2. Wait for native to send the `init` frame. In the bench backend
    //    this is just a synchronisation barrier — the rootKey is not
    //    consumed.
    const initSpan = startBootSpan(sink, "init");
    try {
      await initPromise;
    } catch (e) {
      throw Object.assign(
        e instanceof Error ? e : new Error(String(e)),
        { phase: "init" },
      );
    } finally {
      initSpan.end();
    }

    // 3. Build the bench RPC server and bind the comapeo socket.
    const constructSpan = startBootSpan(sink, "construct");
    try {
      benchRpcServer = new BenchRpcServer({ sink });
      await benchRpcServer.listen(comapeoSocketPath);
    } catch (e) {
      throw Object.assign(
        e instanceof Error ? e : new Error(String(e)),
        { phase: "construct" },
      );
    } finally {
      constructSpan.end();
    }
    console.log(`Bench comapeo socket listening on ${comapeoSocketPath}`);

    controlIpcServer.setReadinessPhase("ready");
  } catch (error) {
    const phase =
      error && typeof error === "object" && "phase" in error
        ? /** @type {{ phase: string }} */ (error).phase
        : "boot";
    handleFatal(phase, error);
  }
})();

process.on("exit", () => {
  console.log("Bench node exiting");
});
