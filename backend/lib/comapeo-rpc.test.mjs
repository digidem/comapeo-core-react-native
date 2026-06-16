import { test } from "node:test";
import assert from "node:assert/strict";
import { createAppRpcClient } from "@comapeo/ipc/client.js";

import { ComapeoRpc } from "./comapeo-rpc.js";
import { SocketMessagePort } from "./message-port.js";
import { connectSocket, socketPath, waitFor } from "./test-helpers.mjs";

/**
 * Minimal stand-in for `@comapeo/map-server`. `listen()` mirrors the real
 * server's non-idempotent behaviour: a second `listen()` on an already-bound
 * server throws ERR_SERVER_ALREADY_LISTEN.
 */
function createFakeMapServer() {
  let listening = false;
  const state = { listenCalls: 0, closeCalls: 0 };
  return {
    state,
    async listen() {
      state.listenCalls++;
      if (listening) {
        throw Object.assign(new Error("already listening"), {
          code: "ERR_SERVER_ALREADY_LISTEN",
        });
      }
      listening = true;
      return { localPort: 1234, remotePort: 5678 };
    },
    async close() {
      state.closeCalls++;
      listening = false;
    },
  };
}

/**
 * @param {import('node:test').TestContext} t
 * @param {string} path
 */
async function connectAppClient(t, path) {
  const socket = await connectSocket(t, path);
  const port = new SocketMessagePort(socket);
  const client = createAppRpcClient(port, { timeout: 5000 });
  port.start();
  t.after(() => port.close());
  return client;
}

test("mapServer.listen() returns the bound ports over RPC", async (t) => {
  const mapServer = createFakeMapServer();
  const server = new ComapeoRpc(
    { comapeoManager: /** @type {any} */ ({}), mapServer },
    {},
  );
  const path = socketPath();
  await server.listen(path);
  t.after(() => server.close());

  const client = await connectAppClient(t, path);
  const result = await client.mapServer.listen();

  assert.deepEqual(result, { localPort: 1234, remotePort: 5678 });
});

// Finding #4: the underlying map server is process-wide, so its listen() must
// stay idempotent across socket connections (a reconnect). A per-connection
// idempotency wrapper would call the real listen() twice and hit
// ERR_SERVER_ALREADY_LISTEN on the second connection.
test("mapServer.listen() is idempotent within and across socket connections", async (t) => {
  const mapServer = createFakeMapServer();
  const server = new ComapeoRpc(
    { comapeoManager: /** @type {any} */ ({}), mapServer },
    {},
  );
  const path = socketPath();
  await server.listen(path);
  t.after(() => server.close());

  const client1 = await connectAppClient(t, path);
  const a = await client1.mapServer.listen();
  const b = await client1.mapServer.listen(); // same connection
  assert.deepEqual(a, { localPort: 1234, remotePort: 5678 });
  assert.deepEqual(b, { localPort: 1234, remotePort: 5678 });

  const client2 = await connectAppClient(t, path); // simulates a reconnect
  const c = await client2.mapServer.listen();
  assert.deepEqual(c, { localPort: 1234, remotePort: 5678 });

  assert.equal(
    mapServer.state.listenCalls,
    1,
    "underlying mapServer.listen() must be called exactly once across connections",
  );
});

// Finding #2 / graceful close: when the socket drops, the close handler must
// tear down BOTH the core RPC server and the app (map) RPC server so their
// message listeners are removed from the port.
test("closing the socket tears down the RPC servers (no leaked listeners)", async (t) => {
  const mapServer = createFakeMapServer();
  const server = new ComapeoRpc(
    { comapeoManager: /** @type {any} */ ({}), mapServer },
    {},
  );
  const path = socketPath();
  await server.listen(path);
  t.after(() => server.close());

  const socket = await connectSocket(t, path);
  const port = new SocketMessagePort(socket);
  const client = createAppRpcClient(port, { timeout: 5000 });
  port.start();

  // Sanity: the channel works before close.
  await client.mapServer.listen();

  // Drop the connection; the server-side port should emit 'close' and the
  // app/core RPC servers should remove their 'message' listeners.
  socket.destroy();

  // server.close() resolves only once all connections are torn down; if the
  // close handler failed to run, this would hang and time out the test.
  await server.close();
  await waitFor(() => server.state === "closed", { message: "server closed" });
  assert.equal(server.state, "closed");
});
