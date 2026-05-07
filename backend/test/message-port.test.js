import { test } from "node:test";
import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import FramedStream from "framed-stream";
import { Buffer } from "node:buffer";

import { SocketMessagePort } from "../lib/message-port.js";

/**
 * In-process duplex pair mirroring AF_UNIX semantics: destroying one side
 * delivers EOF to the peer.
 *
 * @returns {[Duplex, Duplex]}
 */
function pair() {
  /** @type {Duplex} */
  let a;
  /** @type {Duplex} */
  let b;
  a = new Duplex({
    read() {},
    write(chunk, _enc, cb) {
      b.push(chunk);
      cb();
    },
    final(cb) {
      b.push(null);
      cb();
    },
    destroy(_err, cb) {
      if (!b.destroyed) b.destroy();
      cb(null);
    },
  });
  b = new Duplex({
    read() {},
    write(chunk, _enc, cb) {
      a.push(chunk);
      cb();
    },
    final(cb) {
      a.push(null);
      cb();
    },
    destroy(_err, cb) {
      if (!a.destroyed) a.destroy();
      cb(null);
    },
  });
  return [a, b];
}

test("SocketMessagePort emits 'close' once when the underlying socket closes", async () => {
  const [serverSide, clientSide] = pair();
  const port = new SocketMessagePort(serverSide);
  port.start();

  let closeCount = 0;
  port.on("close", () => {
    closeCount++;
  });

  clientSide.destroy();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(closeCount, 1, "close must fire exactly once");
});

test("SocketMessagePort emits 'close' when close() is called directly", async () => {
  const [serverSide] = pair();
  const port = new SocketMessagePort(serverSide);
  port.start();

  let closeCount = 0;
  port.on("close", () => {
    closeCount++;
  });

  port.close();
  port.close();

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(closeCount, 1, "close must be idempotent and fire at most once");
});

test(
  "ComapeoRpcServer-style wiring: handler listeners are removed when the socket closes",
  async () => {
    const { createServer } = await import("rpc-reflector");
    const { EventEmitter } = await import("node:events");

    const handler = new EventEmitter();
    const [serverSide, clientSide] = pair();

    const messagePort = new SocketMessagePort(serverSide);
    messagePort.start();

    const server = createServer(handler, messagePort);
    messagePort.on("close", () => server.close());

    // msgType.ON === 2 in rpc-reflector/lib/constants.js
    const ON = 2;
    const onFrame = Buffer.from(JSON.stringify([ON, "progress", []]));
    const lengthPrefix = Buffer.alloc(4);
    lengthPrefix.writeUInt32LE(onFrame.length, 0);
    clientSide.write(Buffer.concat([lengthPrefix, onFrame]));

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(handler.listenerCount("progress"), 1);

    clientSide.destroy();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(
      handler.listenerCount("progress"),
      0,
      "listener must be removed once the socket closes",
    );
  },
);

test("smoke: FramedStream wired through pair() round-trips a message", async () => {
  const [a, b] = pair();
  const fa = new FramedStream(a);
  const fb = new FramedStream(b);

  const received = new Promise((resolve) => fb.once("data", resolve));
  fa.write(Buffer.from("hello"));

  const buf = await received;
  assert.equal(buf.toString(), "hello");
});
