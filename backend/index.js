import { fileURLToPath } from "node:url";
import Fastify from "fastify";

import { ComapeoRpcServer } from "./lib/comapeo-rpc.js";
import { createComapeo } from "./lib/create-comapeo.js";
import { SimpleRpcServer } from "./lib/simple-rpc.js";

// We define this here so we don't need to do additional bundling adjustments to get the path correct when running on the device
// This assumes that we keep the relevant directory as part of the built assets when building for nodejs mobile
// (see `KEEP_THESE` variable in build-backend.mjs)
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
    const closePromises = [controlIpcServer.close(), fastify.close()];
    if (comapeoRpcServer) closePromises.push(comapeoRpcServer.close());
    await Promise.all(closePromises);
    if (comapeo) await comapeo.close();
  },
});

(async () => {
  try {
    // 1. Bind the control socket. Native is already polling for it; once
    // bound, the `started` broadcast tells native it can send the init frame.
    await controlIpcServer.listen(controlSocketPath);
    console.log(`Control socket listening on ${controlSocketPath}`);
    controlIpcServer.setReadinessPhase("started");

    // 2. Wait for native to send the rootKey. `initPromise` resolves on the
    // first valid init frame; rejects on a malformed one.
    const rootKey = await initPromise;

    // 3. Construct the manager and bind the comapeo RPC socket.
    comapeo = createComapeo({
      privateStorageDir,
      fastify,
      migrationsFolderPath: MIGRATIONS_FOLDER_PATH,
      rootKey,
    });
    comapeoRpcServer = new ComapeoRpcServer(comapeo);
    await comapeoRpcServer.listen(comapeoSocketPath);
    console.log(`Comapeo socket listening on ${comapeoSocketPath}`);

    // 4. Announce ready. The settle-window-then-ready dance is gone now
    // that `ready` carries actual meaning (manager exists, RPC is safe).
    controlIpcServer.setReadinessPhase("ready");
  } catch (error) {
    console.error("Failed to start servers", error);
    process.exit(1);
  }
})();

process.on("exit", () => {
  console.log("node exiting");
});
