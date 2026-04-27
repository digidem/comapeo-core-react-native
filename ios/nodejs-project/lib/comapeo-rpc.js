import net from "node:net";
import { SocketMessagePort } from "./message-port.js";

let count = 0;

/**
 * @param {{path: string}} opts
 */
export function createComapeoRpcServer({ path }) {
  const messagePorts = new Set();
  const comapeoRpcServer = net.createServer((socket) => {
    const messagePort = new SocketMessagePort(socket);
    messagePorts.add(messagePort);
    messagePort.on("message", (message) => {
      messagePort.postMessage(message);
    });
    messagePort.on("messageerror", (error) => {
      console.error("Client sent invalid message", error);
    });
    messagePort.start();
  });

  comapeoRpcServer.on("close", () => {
    for (const messagePort of messagePorts) {
      messagePort.close();
    }
  });

  comapeoRpcServer.listen(path);
  return comapeoRpcServer;
}
