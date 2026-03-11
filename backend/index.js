import { ComapeoRpcServer } from "./lib/comapeo-rpc.js";
import { SimpleRpcServer } from "./lib/simple-rpc.js";
import { createComapeo } from "./lib/create-comapeo.js";
import Fastify from "fastify";

console.log("Starting Comapeo Node server...");

const [comapeoSocketPath, controlSocketPath, privateStorageDir] =
  process.argv.slice(2);

const fastify = Fastify();

const comapeo = createComapeo({
  privateStorageDir,
  fastify,
});

const comapeoRpcServer = new ComapeoRpcServer(comapeo);
const controlIpcServer = new SimpleRpcServer({
  shutdown: () => {
    return Promise.all([
      comapeoRpcServer.close(),
      controlIpcServer.close(),
      fastify.close(),
    ]);
  },
});

controlIpcServer.listen(controlSocketPath);
comapeoRpcServer.listen(comapeoSocketPath);

process.on("exit", () => {
  console.log("node exiting");
});
