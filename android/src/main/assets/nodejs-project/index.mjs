import net from "node:net";
import {Buffer} from "node:buffer";
import FramedStream from "framed-stream";

let count = 0;

const server = net.createServer((socket) => {
  console.log("Client connected");
  const framedStream = new FramedStream(socket);
  framedStream.on("data", (data) => {
    console.log("Client sent:", data.toString("utf-8"));
    framedStream.write(Buffer.from(`Hello from nodejs ${count++}`));
  })
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
