import net from "node:net";
import { SocketMessagePort } from "./message-port.js";

let count = 0;

/**
 * @param {{path: string}} opts
 */
export function createControlRpcServer({ path }) {
  const controlRpcServer = net.createServer((socket) => {
    const messagePort = new SocketMessagePort(socket);
    messagePort.on("message", (message) => {
      messagePort.postMessage(`Hello desde nodejs ${count++}`);
    });
    messagePort.on("messageerror", (error) => {
      console.error("Client sent invalid message", error);
    });
    messagePort.start();
  });

  controlRpcServer.listen(path);
  return controlRpcServer;
}
