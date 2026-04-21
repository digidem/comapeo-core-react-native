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

controlIpcServer.listen(controlSocketPath);
comapeoRpcServer.listen(comapeoSocketPath);

process.on("exit", () => {
  console.log("node exiting");
});
