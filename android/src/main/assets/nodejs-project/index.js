import net from "node:net";
import { SocketMessagePort } from "./lib/message-port.js";
import { once } from "node:events";
import { createComapeoRpcServer } from "./lib/comapeo-rpc.js";
import { createConnectionManager } from "./lib/connection-manager.js";

console.log("Starting Comapeo Node server...");

const [comapeoSocketPath, stateSocketPath] = process.argv.slice(2);

const comapeoRpcServer = createComapeoRpcServer({ path: comapeoSocketPath });
const comapeoRpcConnections = createConnectionManager(comapeoRpcServer);

/** @type {Set<import("./lib/message-port.js").SocketMessagePort>} */
const controlClients = new Set();

const stateIpcServer = net.createServer((socket) => {
  const messagePort = new SocketMessagePort(socket);
  messagePort.on("message", (message) => {
    console.log(`Received message from client: ${JSON.stringify(message)}`);
    if (
      !message ||
      typeof message !== "object" ||
      !("type" in message) ||
      message.type !== "shutdown"
    )
      return;
    comapeoRpcServer.close(() => {
      console.log("comapeoRpcServer closed");
    });
    stateIpcServer.close(() => {
      console.log("stateIpcServer closed");
    });
    Promise.all([
      comapeoRpcConnections.closeAll(),
      stateIpcConnections.closeAll(),
    ]).then(() => {
      console.log("closed all connections");
    });
  });
  controlClients.add(messagePort);
  messagePort.start();
});
const stateIpcConnections = createConnectionManager(stateIpcServer);

stateIpcServer.listen(stateSocketPath);

Promise.all([
  once(stateIpcServer, "listening"),
  once(comapeoRpcServer, "listening"),
]).then(async () => {
  console.log(
    `Node server listening on ${stateSocketPath} and ${comapeoSocketPath}`
  );
  for (const client of controlClients) {
    client.postMessage({ type: "started" });
  }
  await new Promise((res) => setTimeout(res, 1000));
  for (const client of controlClients) {
    client.postMessage({ type: "ready" });
  }
});

process.on("exit", () => {
  console.log("node exiting");
});
