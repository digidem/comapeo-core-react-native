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

const comapeo = createComapeo({
  privateStorageDir,
  fastify,
  migrationsFolderPath: MIGRATIONS_FOLDER_PATH,
});

const comapeoRpcServer = new ComapeoRpcServer(comapeo);
const controlIpcServer = new SimpleRpcServer({
  shutdown: async () => {
    await Promise.all([
      comapeoRpcServer.close(),
      controlIpcServer.close(),
      fastify.close(),
    ]);
    await comapeo.close();
  },
});

// Listen on both sockets in parallel, then drive the readiness state machine.
// `started` fires as soon as both `listen()` promises resolve so a control
// client knows the comapeo socket is accepting connections; `ready` fires
// after a 1 s settle window for callers that want a stronger "I won't see
// startup races" signal. Late-connecting clients receive both replayed.
//
// See SimpleRpcServer for why the settle window exists. The Swift state-IPC
// client polls for the socket file plus retries, which can land its first
// successful accept several tens of ms after the broadcast — without the
// replay it sees nothing.
Promise.all([
  controlIpcServer.listen(controlSocketPath),
  comapeoRpcServer.listen(comapeoSocketPath),
])
  .then(async () => {
    console.log(
      `Node server listening on ${controlSocketPath} and ${comapeoSocketPath}`,
    );
    controlIpcServer.setReadinessPhase("started");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    controlIpcServer.setReadinessPhase("ready");
  })
  .catch((error) => {
    console.error("Failed to start servers", error);
    process.exit(1);
  });

process.on("exit", () => {
  console.log("node exiting");
});
