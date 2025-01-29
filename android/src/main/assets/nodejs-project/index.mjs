import net from "net";
import Buffer from "buffer";

const server = net.createServer((socket) => {
  console.log("Client connected");
  const msg = "Hello from Node.js server!\n";
  const buf = Buffer.from(msg, "utf-8");
  const msgLength = buf.length;
  const msgLengthBuf = Buffer.alloc(4);
  msgLengthBuf.writeUInt32BE(msgLength, 0);
  socket.write(msgLengthBuf);
  socket.write(buf);
  socket.on("data", (data) => {
    console.log("Client sent:", data.subarray(4).toString("utf-8"));
  });
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
