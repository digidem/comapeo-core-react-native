import { test } from "node:test";
import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import FramedStream from "framed-stream";
import { Buffer } from "node:buffer";

import { SocketMessagePort } from "../lib/message-port.js";

/**
 * Builds a pair of connected duplex streams to stand in for a real
 * net.Socket pair. Anything written to `a` is readable from `b` and vice
 * versa, and destroying either side propagates EOF + close to the peer
 * — same as a real AF_UNIX socket pair, which is what the backend
 * connects to in production.
 *
 * Hand-rolled (rather than using `net.createServer` over a temp socket
 * file) so the test stays in-process, runs without filesystem
 * permissions, and finishes in milliseconds.
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
      // Mirrors AF_UNIX behaviour: closing one side delivers EOF to
      // the peer, which then sees its readable end end and closes.
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

  // Simulate the peer disconnecting (e.g. RN reload tears down the
  // socket from the client side). The frame stream observes 'close'
  // and our SocketMessagePort.close() must propagate it.
  clientSide.destroy();

  // Wait one microtask cycle for the close cascade to complete.
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
  // Calling close again must not emit another event — the close handler
  // in ComapeoRpcServer attaches `server.close()` which is idempotent
  // but we still don't want spurious double-fires.
  port.close();

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(closeCount, 1, "close must be idempotent and fire at most once");
});

test(
  "ComapeoRpcServer-style wiring: handler listeners are removed when the socket closes",
  async () => {
    // This is the contract the backend relies on for stale-listener cleanup
    // across RN reloads. We don't pull in @comapeo/ipc here — its
    // createMapeoServer wraps rpc-reflector but the relevant invariant
    // (server.close() removes listeners attached to the handler) is a
    // property of rpc-reflector itself, exercised here directly so the
    // test runs in isolation without the full Mapeo manager surface.
    const { createServer } = await import("rpc-reflector");
    const { EventEmitter } = await import("node:events");

    const handler = new EventEmitter();
    const [serverSide, clientSide] = pair();

    const messagePort = new SocketMessagePort(serverSide);
    messagePort.start();

    // The shape ComapeoRpcServer constructs.
    const server = createServer(handler, messagePort);
    messagePort.on("close", () => server.close());

    // Drive a subscription onto `handler` by sending an [ON, ...] frame
    // through the SocketMessagePort, the same way an rpc-reflector
    // client would after a `clientApi.on('progress', cb)` call.
    // msgType.ON === 2 in rpc-reflector/lib/constants.js
    // (REQUEST=0, RESPONSE=1, ON=2, OFF=3, EMIT=4).
    const ON = 2;
    const onFrame = Buffer.from(JSON.stringify([ON, "progress", []]));
    const lengthPrefix = Buffer.alloc(4);
    lengthPrefix.writeUInt32LE(onFrame.length, 0);
    clientSide.write(Buffer.concat([lengthPrefix, onFrame]));

    // Give the server a tick to install its listener on `handler`.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      handler.listenerCount("progress"),
      1,
      "rpc-reflector should attach exactly one listener after [ON, ...]",
    );

    // Now simulate the client going away — what RN reload looks like
    // from the backend's perspective once the IPC socket closes.
    clientSide.destroy();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(
      handler.listenerCount("progress"),
      0,
      "listener must be removed once the socket closes (regression: " +
        "without SocketMessagePort.emit('close'), the cleanup path " +
        "in ComapeoRpcServer never runs and listeners leak)",
    );
  },
);

// FramedStream is the one piece we lean on directly — make sure the
// test harness's `pair()` actually exercises it the way production does
// (length-prefixed framing, both sides observing close).
test("smoke: FramedStream wired through pair() round-trips a message", async () => {
  const [a, b] = pair();
  const fa = new FramedStream(a);
  const fb = new FramedStream(b);

  const received = new Promise((resolve) => fb.once("data", resolve));
  fa.write(Buffer.from("hello"));

  const buf = await received;
  assert.equal(buf.toString(), "hello");
});
