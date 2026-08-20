import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "rpc-reflector/client.js";

import { ComapeoRpc } from "./comapeo-rpc.js";
import {
  DEBUG_LIFECYCLE_CHANNEL_ID,
  DebugSubChannel,
} from "./debug-lifecycle.js";
import { SocketMessagePort } from "./message-port.js";
import { connectSocket, socketPath, waitFor } from "./test-helpers.mjs";

/**
 * Manager double recording lifecycle calls. Core requests are not exercised —
 * createComapeoCoreServer only forwards calls it never receives here.
 */
function fakeManager() {
  /** @type {string[]} */
  const closed = [];
  /** @type {string[]} */
  const fetched = [];
  const manager = /** @type {any} */ ({
    getProject: async (/** @type {string} */ projectPublicId) => {
      fetched.push(projectPublicId);
      return {
        close: async () => {
          closed.push(projectPublicId);
        },
      };
    },
  });
  return { manager, closed, fetched };
}

/**
 * @param {import('node:test').TestContext} t
 * @param {{ debugLifecycle?: boolean }} [options]
 */
async function startRpc(t, { debugLifecycle } = {}) {
  const { manager, closed, fetched } = fakeManager();
  const server = new ComapeoRpc(
    {
      comapeoManager: manager,
      comapeoServices: {
        mapServer: { getBaseUrl: async () => "http://127.0.0.1:9999" },
      },
    },
    debugLifecycle === undefined ? {} : { debugLifecycle },
  );
  const path = socketPath();
  await server.listen(path);
  t.after(() => server.close());
  return { server, path, closed, fetched };
}

/**
 * @param {import('node:test').TestContext} t
 * @param {string} path
 * @param {{ timeout?: number }} [options]
 */
async function connectDebugClient(t, path, { timeout } = {}) {
  const socket = await connectSocket(t, path);
  const port = new SocketMessagePort(socket);
  const channel = new DebugSubChannel(port, DEBUG_LIFECYCLE_CHANNEL_ID);
  /** @type {any} */
  const client = createClient(channel, timeout ? { timeout } : undefined);
  port.start();
  t.after(() => {
    createClient.close(client);
    channel.close();
  });
  return client;
}

test("closeProject closes the manager's project instance when the flag is on", async (t) => {
  const { path, closed, fetched } = await startRpc(t, {
    debugLifecycle: true,
  });

  const client = await connectDebugClient(t, path);
  await client.closeProject("abc123");

  await waitFor(() => closed.length === 1, { message: "project closed" });
  assert.deepEqual(fetched, ["abc123"]);
  assert.deepEqual(closed, ["abc123"]);
});

test("the debug channel is NOT served by default: calls time out unanswered", async (t) => {
  const { path, closed } = await startRpc(t);

  const client = await connectDebugClient(t, path, { timeout: 200 });
  await assert.rejects(() => client.closeProject("abc123"), /timed? ?out/i);
  assert.equal(closed.length, 0);
});

test("debug frames do not disturb the production channels on the same socket", async (t) => {
  const { path } = await startRpc(t, { debugLifecycle: true });

  // Debug + services clients share one socket-side message port.
  const socket = await connectSocket(t, path);
  const port = new SocketMessagePort(socket);
  const debugChannel = new DebugSubChannel(port, DEBUG_LIFECYCLE_CHANNEL_ID);
  /** @type {any} */
  const debugClient = createClient(debugChannel);
  const { createComapeoServicesClient, closeComapeoServicesClient } =
    await import("@comapeo/ipc/client.js");
  const servicesClient = createComapeoServicesClient(port);
  port.start();
  t.after(() => {
    createClient.close(debugClient);
    debugChannel.close();
    closeComapeoServicesClient(servicesClient);
  });

  await debugClient.closeProject("abc123");
  assert.equal(
    await servicesClient.mapServer.getBaseUrl(),
    "http://127.0.0.1:9999",
  );
});
