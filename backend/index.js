import { fileURLToPath } from "node:url";
import Fastify from "fastify";

import { ComapeoRpcServer } from "./lib/comapeo-rpc.js";
import { createComapeo } from "./lib/create-comapeo.js";
import { SimpleRpcServer } from "./lib/simple-rpc.js";

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
    // exit. AF_UNIX is local and the kernel buffer flushes synchronously
    // enough that peers will see the frame before they see the socket
    // close.
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
   * backend re-broadcasts via `handleFatal` (which calls
   * `broadcastError` and exits 1 after a 100ms flush) so the main-app
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
      console.warn(
        "Received malformed error-native frame, ignoring",
        message,
      );
      return;
    }
    handleFatal(message.phase, new Error(message.message));
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
  try {
    controlIpcServer.broadcastError({
      phase,
      message: err.message,
      stack: err.stack,
    });
  } catch (broadcastErr) {
    console.error("Failed to broadcast error frame", broadcastErr);
  }
  // Give the broadcast a moment to flush over the socket before we
  // tear the process down. The control socket is local AF_UNIX so the
  // kernel buffer flush is fast; a 100ms cap is generous and bounds
  // the worst case where the peer is slow to drain.
  await new Promise((resolve) => setTimeout(resolve, 100));
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

(async () => {
  try {
    // 1. Bind the control socket. Native is already polling for it; once
    // bound, the `started` broadcast tells native it can send the init frame.
    try {
      await controlIpcServer.listen(controlSocketPath);
    } catch (e) {
      throw Object.assign(e, { phase: "listen-control" });
    }
    console.log(`Control socket listening on ${controlSocketPath}`);
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
    try {
      comapeo = createComapeo({
        privateStorageDir,
        fastify,
        migrationsFolderPath: MIGRATIONS_FOLDER_PATH,
        rootKey,
      });
      comapeoRpcServer = new ComapeoRpcServer(comapeo);
      await comapeoRpcServer.listen(comapeoSocketPath);
    } catch (e) {
      throw Object.assign(e, { phase: "construct" });
    }
    console.log(`Comapeo socket listening on ${comapeoSocketPath}`);

    // 4. Announce ready. The settle-window-then-ready dance is gone now
    // that `ready` carries actual meaning (manager exists, RPC is safe).
    controlIpcServer.setReadinessPhase("ready");
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
