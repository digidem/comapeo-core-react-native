import { test } from "node:test";
import assert from "node:assert/strict";

import { ServerHelper } from "./server-helper.js";
import { connectSocket, socketPath, waitFor } from "./test-helpers.mjs";

test("listen() resolves and reports 'started', close() reports 'closed'", async (t) => {
  const server = new ServerHelper(() => {});
  const path = socketPath();

  assert.equal(server.state, "closed");
  await server.listen(path);
  assert.equal(server.state, "started");

  await server.close();
  assert.equal(server.state, "closed");
});

test("close() destroys open connections and resolves", async (t) => {
  /** @type {Array<import('node:net').Socket>} */
  const accepted = [];
  const server = new ServerHelper((socket) => accepted.push(socket));
  const path = socketPath();
  await server.listen(path);

  const clientSocket = await connectSocket(t, path);
  await waitFor(() => accepted.length === 1, { message: "connection accepted" });

  const clientClosed = new Promise((resolve) =>
    clientSocket.once("close", () => resolve(undefined)),
  );

  // Should not hang: close() destroys the still-open accepted connection.
  await server.close();
  assert.equal(server.state, "closed");
  await clientClosed; // the client end observes the server-side teardown
});

test("close() is a no-op when already closed", async (t) => {
  const server = new ServerHelper(() => {});
  const path = socketPath();
  await server.listen(path);

  await server.close();
  await server.close(); // must not throw or hang
  assert.equal(server.state, "closed");
});
