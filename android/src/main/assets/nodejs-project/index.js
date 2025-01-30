import net from "node:net";
import { SocketMessagePort } from "./lib/message-port.js";

let count = 0;

const server = net.createServer((socket) => {
  console.log("Client connected");
  const messagePort = new SocketMessagePort(socket);
  messagePort.on("message", (message) => {
    messagePort.postMessage(`Hello from nodejs ${count++}`);
  });
  messagePort.on("messageerror", (error) => {
    console.error("Client sent invalid message", error);
  });
  messagePort.start();
});

server.listen(process.argv[2], () => {
  console.log("Server started", server.address());
});

server.on("error", (err) => {
  console.error("Server error", err);
});

process.on("exit", () => {
  console.log("node exiting");
});
