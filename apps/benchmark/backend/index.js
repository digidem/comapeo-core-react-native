import { BenchRpcServer } from "./lib/bench-rpc.js";
import { startBootSpan } from "./lib/boot-spans.js";
// Path-import: rollup inlines so the bench bundle uses identical
// framing to production. Divergence here would invalidate the bench.
import { SimpleRpcServer } from "../../../backend/lib/simple-rpc.js";
import { createSinkFromArg } from "./lib/telemetry-sink.js";

/**
 * Bench-only nodejs-mobile entry. Same control-socket state machine as
 * production so the native loader is unchanged; substitutes a relaxed
 * `init` (any object payload accepted; rootKey ignored) and runs
 * `BenchRpcServer` (echo + payload) on the comapeo socket instead of
 * `ComapeoRpcServer` — keeps `@comapeo/core` out of the bundle so what
 * we measure is the bridge, not application init noise.
 */

console.log("Starting Comapeo Node BENCHMARK server...");

// privateStorageDir (3rd positional) is unused: bench doesn't touch disk.
const [comapeoSocketPath, controlSocketPath, , ...rest] =
  process.argv.slice(2);

const telemetryArg = rest.find((a) => a.startsWith("--telemetry="));
const deviceArg = rest.find((a) => a.startsWith("--device="));
const deviceTag = deviceArg ? deviceArg.slice("--device=".length) : "unknown";
const sessionRunId = `boot-${Date.now().toString(36)}-${Math.random()
  .toString(36)
  .slice(2, 8)}`;
const sink = createSinkFromArg(
  telemetryArg ? telemetryArg.slice("--telemetry=".length) : undefined,
  { runId: sessionRunId, device: deviceTag },
);

/** @type {BenchRpcServer | undefined} */
let benchRpcServer;
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
  /** @param {Record<string, unknown>} message */
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
    // `stopping` before close so native distinguishes graceful exit from crash.
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
 * Filters the streamx-microtask shutdown race: `ERR_STREAM_WRITE_AFTER_END`
 * raised while shutting down is benign (peer is going away). Caught in both
 * `uncaughtException` and `unhandledRejection` since Node surfaces it via
 * either path depending on which microtask boundary it crosses.
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

    // `init` is just a sync barrier here — rootKey is unused.
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
