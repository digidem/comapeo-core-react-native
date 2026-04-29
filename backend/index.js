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

const [
  comapeoSocketPath,
  controlSocketPath,
  privateStorageDir,
  mediaSocketPath,
] = process.argv.slice(2);

if (!mediaSocketPath) {
  console.error(
    "Missing media socket path argv. The native NodeJSService must pass " +
      "[node, indexPath, comapeoSocketPath, controlSocketPath, privateStorageDir, mediaSocketPath].",
  );
  process.exit(1);
}

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

// Listen on all three sockets in parallel, then drive the readiness state
// machine. `started` fires as soon as the listen() promises resolve so a
// control client knows the sockets are accepting connections; `ready`
// fires after a 1 s settle window for callers that want a stronger
// "I won't see startup races" signal. Late-connecting clients receive both
// replayed.
//
// See SimpleRpcServer for why the settle window exists. Native control-IPC
// clients (Swift, Kotlin) poll for the socket file plus retry, which can
// land their first successful accept several tens of ms after the
// broadcast — without the replay they would see nothing.
//
// The media socket carries blob/icon HTTP responses streamed by the Fastify
// plugins registered in `@comapeo/core`. Binding to a UDS instead of a TCP
// port keeps the bytes inside the app sandbox: only the native module can
// connect (Android via LocalSocket from the MediaContentProvider, iOS via
// AF_UNIX from MediaURLProtocol), so no other app on the device can read
// the URLs.
Promise.all([
  controlIpcServer.listen(controlSocketPath),
  comapeoRpcServer.listen(comapeoSocketPath),
  fastify.listen({ path: mediaSocketPath }),
])
  .then(async () => {
    console.log(
      `Node server listening on ${controlSocketPath}, ${comapeoSocketPath}, ${mediaSocketPath}`,
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
