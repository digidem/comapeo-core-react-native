import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { inspect } from "node:util";
import FramedStream from "framed-stream";

import { SimpleRpcServer } from "./simple-rpc.js";
import { SocketMessagePort } from "./message-port.js";
import * as metrics from "./metrics.js";
import { connectSocket, socketPath, waitFor } from "./test-helpers.mjs";

/**
 * @param {import('node:test').TestContext} t
 * @param {Record<string, (message: any) => void>} methods
 */
async function startServer(t, methods) {
  const server = new SimpleRpcServer(methods);
  const path = socketPath();
  await server.listen(path);
  t.after(() => server.close());
  return { server, path };
}

// Regression test for the control-socket boot break: the message-port rewrite
// dropped the EventEmitter `.on()` API, but #onConnection still called
// `messagePort.on(...)`, throwing "messagePort.on is not a function" on the
// first connection — the connection that carries `init`/`rootKey` from native.
test("a connecting client's message reaches the matching method handler", async (t) => {
  /** @type {unknown[]} */
  const received = [];
  const { path } = await startServer(t, {
    init: (message) => received.push(message),
  });

  const socket = await connectSocket(t, path);
  const client = new SocketMessagePort(socket);
  client.start();
  client.postMessage({ type: "init", rootKey: "deadbeef" });

  await waitFor(() => received.length === 1, { message: "init handled" });
  assert.deepEqual(received[0], { type: "init", rootKey: "deadbeef" });
});

test("replays readiness phases to a late-connecting client", async (t) => {
  const { server, path } = await startServer(t, {});
  server.setReadinessPhase("started");
  server.setReadinessPhase("ready");

  const socket = await connectSocket(t, path);
  const client = new SocketMessagePort(socket);
  /** @type {Array<{ type?: string }>} */
  const frames = [];
  client.addEventListener("message", (event) => frames.push(event.data));
  client.start();

  await waitFor(() => frames.some((f) => f && f.type === "ready"), {
    message: "ready replayed",
  });
  const types = frames.map((f) => f.type);
  assert.ok(types.includes("started"), "should replay 'started'");
  assert.ok(types.includes("ready"), "should replay 'ready'");
});

test("broadcast delivers a frame to a connected client", async (t) => {
  const { server, path } = await startServer(t, {});

  const socket = await connectSocket(t, path);
  const client = new SocketMessagePort(socket);
  /** @type {Array<{ type?: string }>} */
  const frames = [];
  client.addEventListener("message", (event) => frames.push(event.data));
  client.start();

  server.broadcast({ type: "stopping" });

  await waitFor(() => frames.some((f) => f && f.type === "stopping"), {
    message: "broadcast delivered",
  });
});

test("an unknown message type is ignored without throwing", async (t) => {
  let called = false;
  const { path } = await startServer(t, {
    init: () => {
      called = true;
    },
  });

  const socket = await connectSocket(t, path);
  const client = new SocketMessagePort(socket);
  client.start();
  client.postMessage({ type: "does-not-exist" });
  client.postMessage({ type: "init" });

  await waitFor(() => called, { message: "valid message still handled" });
  assert.ok(called, "later valid message must still be handled");
});

test("a non-string or missing type is ignored without throwing", async (t) => {
  let called = false;
  const { path } = await startServer(t, {
    init: () => {
      called = true;
    },
  });

  const socket = await connectSocket(t, path);
  const client = new SocketMessagePort(socket);
  client.start();
  client.postMessage(/** @type {any} */ ({ type: 42 }));
  client.postMessage(/** @type {any} */ ({ type: null }));
  client.postMessage(/** @type {any} */ ({ noType: true }));
  client.postMessage("just a string");
  client.postMessage({ type: "init" });

  await waitFor(() => called, { message: "valid message still handled" });
  assert.ok(called, "a later well-formed message must still be handled");
});

test("a registered handler that is not a function is warned and skipped", async (t) => {
  /** @type {unknown[][]} */
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  t.after(() => {
    console.warn = originalWarn;
  });

  const { path } = await startServer(
    t,
    /** @type {any} */ ({ broken: "not a function" }),
  );

  const socket = await connectSocket(t, path);
  const client = new SocketMessagePort(socket);
  client.start();
  client.postMessage({ type: "broken" });

  await waitFor(
    () => warnings.some((w) => String(w[0]).includes("not a function")),
    { message: "non-function handler warned" },
  );
});

test("a malformed frame does not crash the server", async (t) => {
  /** @type {unknown[]} */
  const received = [];
  const { path } = await startServer(t, {
    init: (message) => received.push(message),
  });

  const socket = await connectSocket(t, path);
  const raw = new FramedStream(socket);
  raw.write(Buffer.from("garbage not json"));

  // After the bad frame, a well-formed message must still be processed,
  // proving the connection survived the messageerror.
  raw.write(Buffer.from(JSON.stringify({ type: "init", ok: true })));

  await waitFor(() => received.length === 1, { message: "survived bad frame" });
  assert.deepEqual(received[0], { type: "init", ok: true });
});

// The control socket carries the init frame with the rootKey, so neither
// the invalid-message path nor the parse-error path may log payload
// content — V8's JSON.parse SyntaxError even embeds a snippet of the raw
// input, so logging `event.data` (an Error) would leak key bytes too.
test("invalid messages and malformed frames are logged without payload content", async (t) => {
  const SECRET = "MDEyMzQ1Njc4OWFiY2RlZg==";
  /** @type {unknown[][]} */
  const logged = [];
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = (...args) => logged.push(args);
  console.error = (...args) => logged.push(args);
  t.after(() => {
    console.warn = originalWarn;
    console.error = originalError;
  });

  let called = false;
  const { path } = await startServer(t, {
    init: () => {
      called = true;
    },
  });

  const socket = await connectSocket(t, path);
  const raw = new FramedStream(socket);
  // Unknown-type message carrying the key — the invalid-message warn path.
  raw.write(Buffer.from(JSON.stringify({ type: "unknown", rootKey: SECRET })));
  // Truncated init frame — the JSON.parse messageerror path.
  raw.write(Buffer.from(`{"type":"init","rootKey":"${SECRET}"`));
  raw.write(Buffer.from(JSON.stringify({ type: "init" })));

  await waitFor(() => called, { message: "valid message still handled" });
  assert.ok(logged.length >= 2, "both bad frames must have been logged");
  const flat = logged.map((args) => args.map((a) => inspect(a)).join(" ")).join("\n");
  assert.ok(
    !flat.includes(SECRET.slice(0, 12)),
    `logged output must not contain key material, got: ${flat}`,
  );
});

test("a malformed frame on the control socket records comapeo.ipc.errors", async (t) => {
  /** @type {Array<{ name: string, attributes: Record<string, unknown> }>} */
  const counts = [];
  metrics.init({
    Sentry: /** @type {any} */ ({
      metrics: {
        count: (name, value, data) => counts.push({ name, ...data }),
      },
    }),
    platform: "android",
    deviceClass: "mid",
    osMajor: "android.14",
    applicationUsageData: false,
  });
  t.after(() => metrics.resetForTests());

  const { path } = await startServer(t, {});
  const socket = await connectSocket(t, path);
  const raw = new FramedStream(socket);
  raw.write(Buffer.from("garbage not json"));

  await waitFor(() => counts.some((c) => c.name === "comapeo.ipc.errors"), {
    message: "ipc error metric recorded",
  });
  const err = counts.find((c) => c.name === "comapeo.ipc.errors");
  assert.equal(err?.attributes.error_class, "SyntaxError");
});
