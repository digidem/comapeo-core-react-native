import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
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

test("throws when rootKey is not 16 bytes", async (t) => {
  const privateStorageDir = await tempDir(t);
  assert.throws(
    () => createMapServer({ privateStorageDir, rootKey: Buffer.alloc(8) }),
    /rootKey must be 16 bytes/,
  );
});
