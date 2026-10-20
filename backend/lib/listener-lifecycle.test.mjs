import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, request } from "node:http";
import { connect, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyManager } from "@comapeo/crypto";
import Fastify from "fastify";

import { createMapServer } from "./create-map-server.js";
import { createListenerLifecycle } from "./listener-lifecycle.js";

/** @param {number} port */
function tryConnect(port) {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve("connected");
    });
    socket.once("error", (/** @type {NodeJS.ErrnoException} */ err) =>
      resolve(err.code),
    );
  });
}

/** @param {import('node:test').TestContext} t */
async function startFastify(t) {
  const fastify = Fastify();
  /** @type {() => void} */
  let release = () => {};
  /** @type {(value?: unknown) => void} */
  let onSlowStarted = () => {};
  const slowStarted = new Promise((resolve) => (onSlowStarted = resolve));
  fastify.get("/ok", async () => "ok");
  fastify.get("/slow", (_req, reply) => {
    reply.raw.write("a");
    release = () => reply.raw.end("b");
    onSlowStarted();
  });
  await fastify.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => fastify.close());
  const { port } = /** @type {import("node:net").AddressInfo} */ (
    fastify.server.address()
  );
  return { fastify, port, slowStarted, release: () => release() };
}

/** @param {import('node:test').TestContext} t */
async function startMapServer(t) {
  const style = createHttpServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ version: 8, sources: {}, layers: [] }));
  });
  style.listen(0, "127.0.0.1");
  await once(style, "listening");
  t.after(() => new Promise((resolve) => style.close(resolve)));
  const stylePort = /** @type {import("node:net").AddressInfo} */ (
    style.address()
  ).port;

  const privateStorageDir = await mkdtemp(join(tmpdir(), "comapeo-listen-"));
  t.after(() => rm(privateStorageDir, { recursive: true, force: true }));
  const server = createMapServer({
    privateStorageDir,
    identityKeypair: new KeyManager(Buffer.alloc(16, 1)).getIdentityKeypair(),
    defaultOnlineStyleUrl: `http://127.0.0.1:${stylePort}/style.json`,
  });
  t.after(() => server.close());
  const ports = await server.listen();
  return { server, ports };
}

/** @param {import("node:net").Server} fastifyServer */
function createLifecycle(fastifyServer) {
  /** @type {Array<[string, number, number]>} */
  const portChanges = [];
  const listeners = createListenerLifecycle({
    fastifyServer,
    onPortChange: (name, from, to) => portChanges.push([name, from, to]),
  });
  return { listeners, portChanges };
}

test("background stops both servers listening; foreground restores the same ports", async (t) => {
  const { fastify, port } = await startFastify(t);
  const { server, ports } = await startMapServer(t);
  const { listeners, portChanges } = createLifecycle(fastify.server);
  listeners.setMapServer(server, ports);

  await listeners.background();
  assert.equal(await tryConnect(port), "ECONNREFUSED");
  assert.equal(await tryConnect(ports.localPort), "ECONNREFUSED");
  assert.equal(await tryConnect(ports.remotePort), "ECONNREFUSED");

  await listeners.foreground();
  const res = await fetch(`http://127.0.0.1:${port}/ok`);
  assert.equal(await res.text(), "ok");
  const style = await fetch(
    `http://127.0.0.1:${ports.localPort}/maps/default/style.json`,
  );
  assert.equal(style.status, 200);
  assert.equal(await tryConnect(ports.remotePort), "connected");
  assert.deepEqual(listeners.getMapServerPorts(), ports);
  assert.deepEqual(portChanges, []);
});

test("open connections survive a background/foreground cycle", async (t) => {
  const { fastify, port, slowStarted, release } = await startFastify(t);
  const { listeners } = createLifecycle(fastify.server);

  const body = new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port, path: "/slow" }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
    })
      .on("error", reject)
      .end();
  });
  await slowStarted;

  await listeners.background();
  await listeners.foreground();
  release();
  assert.equal(await body, "ab");
});

test("foreground rebinds servers that started listening after background", async (t) => {
  // App backgrounded while boot was still running: neither server was
  // listening yet, so background() could not reach them.
  const fastify = Fastify();
  fastify.get("/ok", async () => "ok");
  t.after(() => fastify.close());
  const { listeners } = createLifecycle(fastify.server);
  await listeners.background();

  await fastify.listen({ host: "127.0.0.1", port: 0 });
  const { port } = /** @type {import("node:net").AddressInfo} */ (
    fastify.server.address()
  );
  const { server, ports } = await startMapServer(t);
  listeners.setMapServer(server, ports);

  let fastifyRebinds = 0;
  fastify.server.on("listening", () => fastifyRebinds++);
  await listeners.foreground();

  assert.equal(fastifyRebinds, 1);
  const res = await fetch(`http://127.0.0.1:${port}/ok`);
  assert.equal(await res.text(), "ok");
  assert.deepEqual(listeners.getMapServerPorts(), ports);
});

test("foreground recovers a reclaimed socket that background never reached", async (t) => {
  const { fastify, port } = await startFastify(t);
  const { listeners } = createLifecycle(fastify.server);

  // A reclaimed socket fails every operation; getsockname() throws EBADF.
  const realAddress = fastify.server.address.bind(fastify.server);
  fastify.server.address = () => {
    throw Object.assign(new Error("getsockname EBADF"), { code: "EBADF" });
  };
  fastify.server.prependOnceListener("listening", () => {
    fastify.server.address = realAddress;
  });

  await listeners.foreground();
  const res = await fetch(`http://127.0.0.1:${port}/ok`);
  assert.equal(await res.text(), "ok");
});

test("reports a port change if a port was taken while paused", async (t) => {
  const { fastify, port } = await startFastify(t);
  const { server, ports } = await startMapServer(t);
  const { listeners, portChanges } = createLifecycle(fastify.server);
  listeners.setMapServer(server, ports);

  await listeners.background();
  const blocker = createNetServer();
  blocker.listen(ports.localPort, "127.0.0.1");
  await once(blocker, "listening");
  const fastifyBlocker = createNetServer();
  fastifyBlocker.listen(port, "127.0.0.1");
  await once(fastifyBlocker, "listening");
  t.after(() => {
    blocker.close();
    fastifyBlocker.close();
  });

  await listeners.foreground();
  const newPorts = listeners.getMapServerPorts();
  assert.ok(newPorts);
  assert.notEqual(newPorts.localPort, ports.localPort);
  assert.equal(newPorts.remotePort, ports.remotePort);
  const newFastifyPort = /** @type {import("node:net").AddressInfo} */ (
    fastify.server.address()
  ).port;
  assert.deepEqual(portChanges.sort(), [
    ["blob-server", port, newFastifyPort],
    ["map-server-local", ports.localPort, newPorts.localPort],
  ]);
});

test("foreground before anything is listening is a no-op", async () => {
  const fastify = Fastify();
  const { listeners } = createLifecycle(fastify.server);
  await listeners.background();
  await listeners.foreground();
  assert.equal(fastify.server.listening, false);
  assert.equal(listeners.getMapServerPorts(), undefined);
});

test("shutdown while paused still closes cleanly", async (t) => {
  const { fastify } = await startFastify(t);
  const { server, ports } = await startMapServer(t);
  const { listeners } = createLifecycle(fastify.server);
  listeners.setMapServer(server, ports);

  await listeners.background();
  await Promise.all([fastify.close(), server.close()]);
});
