import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import FramedStream from "framed-stream";

import { SocketMessagePort } from "./message-port.js";
import { connectedSocketPair, delay, waitFor } from "./test-helpers.mjs";

test("delivers a message with the payload in event.data", async (t) => {
  const { serverSocket, clientSocket } = await connectedSocketPair(t);
  const sender = new SocketMessagePort(clientSocket);
  const receiver = new SocketMessagePort(serverSocket);

  /** @type {unknown[]} */
  const received = [];
  receiver.addEventListener("message", (event) => received.push(event.data));
  receiver.start();

  sender.postMessage({ hello: "world", n: 1 });

  await waitFor(() => received.length === 1, { message: "message delivered" });
  assert.deepEqual(received[0], { hello: "world", n: 1 });
});

test("messages received before start() are queued and flushed in order", async (t) => {
  const { serverSocket, clientSocket } = await connectedSocketPair(t);
  const sender = new SocketMessagePort(clientSocket);
  const receiver = new SocketMessagePort(serverSocket);

  /** @type {unknown[]} */
  const received = [];
  receiver.addEventListener("message", (event) => received.push(event.data));

  sender.postMessage({ n: 1 });
  sender.postMessage({ n: 2 });
  sender.postMessage({ n: 3 });

  // Give the frames time to arrive while the receiver is still "idle".
  await delay(50);
  assert.deepEqual(received, [], "messages must queue, not deliver, before start()");

  receiver.start();
  await waitFor(() => received.length === 3, { message: "queue flushed" });
  assert.deepEqual(received, [{ n: 1 }, { n: 2 }, { n: 3 }]);
});

test("a malformed frame dispatches 'messageerror' (not 'message') with the Error in event.data", async (t) => {
  const { serverSocket, clientSocket } = await connectedSocketPair(t);
  const receiver = new SocketMessagePort(serverSocket);
  receiver.start();

  /** @type {unknown[]} */
  const messages = [];
  /** @type {unknown[]} */
  const errors = [];
  receiver.addEventListener("message", (event) => messages.push(event.data));
  receiver.addEventListener("messageerror", (event) => errors.push(event.data));

  // Write a raw framed buffer whose contents are not valid JSON.
  const rawSender = new FramedStream(clientSocket);
  rawSender.write(Buffer.from("this is not json {"));

  await waitFor(() => errors.length === 1, { message: "messageerror dispatched" });
  assert.equal(messages.length, 0, "must not be delivered as a message");
  assert.ok(errors[0] instanceof Error, "event.data should be an Error");
});

test("close() is idempotent and dispatches 'close' exactly once", async (t) => {
  const { serverSocket } = await connectedSocketPair(t);
  const port = new SocketMessagePort(serverSocket);

  let closeCount = 0;
  port.addEventListener("close", () => closeCount++);

  port.close();
  port.close();
  port.close();

  assert.equal(closeCount, 1);
});

test("the underlying socket closing triggers a 'close' event", async (t) => {
  const { serverSocket, clientSocket } = await connectedSocketPair(t);
  const port = new SocketMessagePort(serverSocket);

  const closed = new Promise((resolve) =>
    port.addEventListener("close", () => resolve(undefined)),
  );

  // Remote end goes away → serverSocket 'close' → framedStream 'close' → port.close().
  clientSocket.destroy();

  await closed; // hangs (and times out the test) if close is never dispatched
});

test("removeEventListener stops further delivery", async (t) => {
  const { serverSocket, clientSocket } = await connectedSocketPair(t);
  const sender = new SocketMessagePort(clientSocket);
  const receiver = new SocketMessagePort(serverSocket);
  receiver.start();

  let count = 0;
  const listener = () => count++;
  receiver.addEventListener("message", listener);

  sender.postMessage({ a: 1 });
  await waitFor(() => count === 1, { message: "first message delivered" });

  receiver.removeEventListener("message", listener);
  sender.postMessage({ a: 2 });
  await delay(50);

  assert.equal(count, 1, "removed listener must not receive further messages");
});

test("addEventListener / removeEventListener throw on an unknown event type", async (t) => {
  const { serverSocket } = await connectedSocketPair(t);
  const port = new SocketMessagePort(serverSocket);

  assert.throws(
    () => port.addEventListener(/** @type {any} */ ("bogus"), () => {}),
    /Invalid MessagePort event type/,
  );
  assert.throws(
    () => port.removeEventListener(/** @type {any} */ ("bogus"), () => {}),
    /Invalid MessagePort event type/,
  );
});
