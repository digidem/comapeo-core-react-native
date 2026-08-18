import { createServer } from "node:http";
import { connect } from "node:net";
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { Agent, fetch } from "./undici-shim.js";

const server = createServer((_req, res) => {
  res.end("hello");
});
/** @type {Promise<void>} */
const listening = new Promise((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve());
});

after(() => {
  server.close();
});

/** @returns {Promise<string>} */
async function origin() {
  await listening;
  const address = server.address();
  assert.ok(address && typeof address === "object", "server has a TCP address");
  return `http://127.0.0.1:${address.port}`;
}

test("exports a callable fetch", async () => {
  assert.equal(typeof fetch, "function");
  const response = await fetch(`${await origin()}/`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "hello");
});

test("Agent is a dispatcher class accepting a connect option", () => {
  assert.equal(typeof Agent, "function");
  const agent = new Agent({ connect: () => {} });
  assert.equal(typeof agent.dispatch, "function");
});

test("a subclass's custom connect is used for the request", async () => {
  let connectCalls = 0;

  class CountingAgent extends Agent {
    constructor() {
      super({
        connect: ({ hostname, port }, callback) => {
          connectCalls++;
          const socket = connect({ host: hostname, port: Number(port) }, () => {
            callback(null, socket);
          });
          socket.once("error", (err) => {
            callback(err, null);
          });
        },
      });
    }
  }

  const agent = new CountingAgent();
  const response = await fetch(`${await origin()}/`, { dispatcher: agent });

  assert.equal(await response.text(), "hello");
  assert.equal(connectCalls, 1, "the subclass's connect handled the request");
  await agent.close();
});
