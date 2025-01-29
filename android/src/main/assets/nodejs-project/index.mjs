import net from "node:net";
import {Buffer} from "node:buffer";
import FramedStream from "framed-stream";

const server = net.createServer((socket) => {
  console.log("Client connected");
  const framedStream = new FramedStream(socket);
  framedStream.on("data", (data) => {
    console.log("Client sent:", data.toString("utf-8"));
  })
  framedStream.write(Buffer.from("Hello from Node.js server!\n", "utf-8"));
  framedStream.write(Buffer.from("Long test message,".repeat(10), "utf-8"));
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
