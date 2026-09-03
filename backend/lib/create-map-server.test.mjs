import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { KeyManager } from "@comapeo/crypto";

import { createMapServer } from "./create-map-server.js";

// index.js passes the identity keypair off its one shared KeyManager; the
// tests build theirs the same way rather than hand-rolling key bytes.
const identityKeypairFor = (/** @type {Buffer} */ rootKey) =>
  new KeyManager(rootKey).getIdentityKeypair();

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

test("rejects an identityKeypair with the wrong key lengths or types", async (t) => {
  const privateStorageDir = await tempDir(t);
  const valid = identityKeypairFor(Buffer.alloc(16, 1));
  const createWith = (/** @type {unknown} */ identityKeypair) => () =>
    createMapServer({
      privateStorageDir,
      identityKeypair: /** @type {any} */ (identityKeypair),
    });

  assert.throws(createWith(undefined), /publicKey must be a 32-byte Buffer/);
  assert.throws(
    createWith({ ...valid, publicKey: Buffer.alloc(16) }),
    /publicKey must be a 32-byte Buffer/,
  );
  assert.throws(
    createWith({ ...valid, secretKey: new Uint8Array(64) }),
    /secretKey must be a 64-byte Buffer/,
  );
});

test("creates the maps dir and returns a server with listen/close", async (t) => {
  const privateStorageDir = await tempDir(t);
  const server = createMapServer({
    privateStorageDir,
    identityKeypair: identityKeypairFor(Buffer.alloc(16, 1)),
  });
  t.after(() => server.close());

  assert.ok(
    existsSync(join(privateStorageDir, "maps")),
    "custom maps dir is created",
  );
  assert.equal(typeof server.listen, "function");
  assert.equal(typeof server.close, "function");
});

test("accepts the same identity keypair twice (same key, no throw)", async (t) => {
  const privateStorageDir = await tempDir(t);
  const identityKeypair = identityKeypairFor(Buffer.alloc(16, 7));
  const a = createMapServer({ privateStorageDir, identityKeypair });
  const b = createMapServer({ privateStorageDir, identityKeypair });
  t.after(() => Promise.all([a.close(), b.close()]));
  // Same keypair + dir must not throw on a second construction.
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
    identityKeypair: identityKeypairFor(Buffer.alloc(16, 1)),
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
