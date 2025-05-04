import net from "node:net";
import { SocketMessagePort } from "./lib/message-port.js";
import { once } from "node:events";
import { createComapeoRpcServer } from "./lib/comapeo-rpc.js";

const [comapeoSocketPath, stateSocketPath] = process.argv.slice(2);

const comapeoRpcServer = createComapeoRpcServer({ path: comapeoSocketPath });

/** @type {Set<import("./lib/message-port.js").MessagePortLike>} */
const controlClients = new Set();

const stateIpcServer = net.createServer((socket) => {
  const messagePort = new SocketMessagePort(socket);
  messagePort.on("message", (message) => {
    if (
      !message ||
      typeof message !== "object" ||
      !("type" in message) ||
      message.type !== "shutdown"
    )
      return;
    comapeoRpcServer.close();
    stateIpcServer.close();
  });
  controlClients.add(messagePort);
  messagePort.start();
});

stateIpcServer.listen(stateSocketPath);

Promise.all([
  once(stateIpcServer, "listening"),
  once(comapeoRpcServer, "listening"),
]).then(() => {
  console.log(
    `Node server listening on ${stateSocketPath} and ${comapeoSocketPath}`
  );
  for (const client of controlClients) {
    client.postMessage({ type: "started" });
  }
});

process.on("exit", () => {
  console.log("node exiting");
});
