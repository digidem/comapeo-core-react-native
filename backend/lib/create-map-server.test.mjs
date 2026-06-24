import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";

import { createMapServer } from "./create-map-server.js";

/** @param {import('node:test').TestContext} t */
async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "comapeo-map-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Starts a local HTTP server serving a minimal MapLibre style.json, so the
 * map server's online-style fetch resolves without hitting the network.
 * @param {import('node:test').TestContext} t
 * @returns {Promise<string>} the style URL
 */
async function startStubStyleServer(t) {
  const style = JSON.stringify({ version: 8, sources: {}, layers: [] });
  const server = createHttpServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(style);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return `http://127.0.0.1:${address.port}/style.json`;
}

test("creates the maps dir and returns a server with listen/close", async (t) => {
  const privateStorageDir = await tempDir(t);
  const server = createMapServer({
    privateStorageDir,
    rootKey: Buffer.alloc(16, 1),
  });
  t.after(() => server.close());

  assert.ok(
    existsSync(join(privateStorageDir, "maps")),
    "custom maps dir is created",
  );
  assert.equal(typeof server.listen, "function");
  assert.equal(typeof server.close, "function");
});

test("derives the keypair deterministically from rootKey (same key, no throw)", async (t) => {
  const privateStorageDir = await tempDir(t);
  const rootKey = Buffer.alloc(16, 7);
  const a = createMapServer({ privateStorageDir, rootKey });
  const b = createMapServer({ privateStorageDir, rootKey });
  t.after(() => Promise.all([a.close(), b.close()]));
  // Same rootKey + dir must not throw on a second construction.
  assert.ok(a);
  assert.ok(b);
});

// Regression guard: the consumer's `defaultOnlineStyleUrl` (set via the
// Expo plugin, forwarded as the backend's 5th argv positional) must reach
// the standalone map server the app fetches styles from — not just
// MapeoManager. The `default` map handler serves custom → online → fallback;
// with no custom map uploaded it redirects to the configured online URL.
test("default map handler serves the configured defaultOnlineStyleUrl", async (t) => {
  const styleUrl = await startStubStyleServer(t);
  const privateStorageDir = await tempDir(t);
  const server = createMapServer({
    privateStorageDir,
    rootKey: Buffer.alloc(16, 1),
    defaultOnlineStyleUrl: styleUrl,
  });
  t.after(() => server.close());

  const { localPort } = await server.listen();
  const response = await fetch(
    `http://127.0.0.1:${localPort}/maps/default/style.json`,
    { redirect: "manual" },
  );
  await response.body?.cancel();

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), styleUrl);
});

test("throws when rootKey is not 16 bytes", async (t) => {
  const privateStorageDir = await tempDir(t);
  assert.throws(
    () => createMapServer({ privateStorageDir, rootKey: Buffer.alloc(8) }),
    /rootKey must be 16 bytes/,
  );
});
