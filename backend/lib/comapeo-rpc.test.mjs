import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import FramedStream from "framed-stream";
import {
  createComapeoServicesClient,
  closeComapeoServicesClient,
} from "@comapeo/ipc/client.js";

import { ComapeoRpc } from "./comapeo-rpc.js";
import { SocketMessagePort } from "./message-port.js";
import * as metrics from "./metrics.js";
import { connectSocket, socketPath, waitFor } from "./test-helpers.mjs";

// Core requests aren't exercised here, so a bare object stands in for the
// manager — createComapeoCoreServer only forwards calls it never receives.
const fakeManager = () => /** @type {any} */ ({});

/**
 * @param {import('node:test').TestContext} t
 * @param {import('@comapeo/ipc/server.js').ComapeoServicesApi} comapeoServices
 */
async function startRpc(t, comapeoServices) {
  const server = new ComapeoRpc({
    comapeoManager: fakeManager(),
    comapeoServices,
  });
  const path = socketPath();
  await server.listen(path);
  t.after(() => server.close());
  return { server, path };
}

/**
 * @param {import('node:test').TestContext} t
 * @param {string} path
 */
async function connectServicesClient(t, path) {
  const socket = await connectSocket(t, path);
  const port = new SocketMessagePort(socket);
  const client = createComapeoServicesClient(port);
  port.start();
  t.after(() => closeComapeoServicesClient(client));
  return client;
}

test("serves the map-server services API to a connecting client", async (t) => {
  const { path } = await startRpc(t, {
    mapServer: { getBaseUrl: async () => "http://127.0.0.1:9999" },
  });

  const client = await connectServicesClient(t, path);
  assert.equal(await client.mapServer.getBaseUrl(), "http://127.0.0.1:9999");
});

test("propagates a services-handler rejection to the client", async (t) => {
  const { path } = await startRpc(t, {
    mapServer: {
      getBaseUrl: async () => {
        throw new Error("map server unavailable");
      },
    },
  });

  const client = await connectServicesClient(t, path);
  await assert.rejects(
    () => client.mapServer.getBaseUrl(),
    /map server unavailable/,
  );
});

test("a client disconnecting does not stop the server serving the next client", async (t) => {
  let calls = 0;
  const { path } = await startRpc(t, {
    mapServer: {
      getBaseUrl: async () => `http://127.0.0.1:${1000 + calls++}`,
    },
  });

  const first = await connectServicesClient(t, path);
  assert.equal(await first.mapServer.getBaseUrl(), "http://127.0.0.1:1000");
  closeComapeoServicesClient(first);

  // Per-connection servers from the first client are torn down on close()
  // (the listener registered before start()); a fresh client must still work.
  const second = await connectServicesClient(t, path);
  assert.equal(await second.mapServer.getBaseUrl(), "http://127.0.0.1:1001");
});

test("a malformed frame on the comapeo socket records comapeo.ipc.errors", async (t) => {
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

  const { path } = await startRpc(t, {
    mapServer: { getBaseUrl: async () => "http://127.0.0.1:9999" },
  });
  const socket = await connectSocket(t, path);
  const raw = new FramedStream(socket);
  raw.write(Buffer.from("garbage not json"));

  await waitFor(() => counts.some((c) => c.name === "comapeo.ipc.errors"), {
    message: "ipc error metric recorded",
  });
  const err = counts.find((c) => c.name === "comapeo.ipc.errors");
  assert.equal(err?.attributes.error_class, "SyntaxError");
});
