import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyManager, deriveMasterKeyFromRootKey } from "@comapeo/crypto";

import { createComapeo } from "./create-comapeo.js";

// Pinned (rootKey, masterKey) vector, shared with @comapeo/crypto's own
// derivation test and the master-key frame test. Drift in this mapping is
// fleet-wide identity loss, so it is asserted rather than assumed.
const ROOT_KEY = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
const MASTER_KEY = Buffer.from(
  "bed4350c496024724d50592eb2cd4f61b3333ea871c495f63a4f687aed67f82c",
  "hex",
);

// Lets a case pass only the options it cares about — the rejection cases
// never get past the key checks, and the pass-through case swaps
// MapeoManager for a stub.
const createWith = (/** @type {Record<string, unknown>} */ options) =>
  createComapeo(/** @type {any} */ (options));

test("rejects a rootKey that is not a 16-byte Buffer", () => {
  assert.throws(
    () => createWith({ rootKey: Buffer.alloc(8) }),
    /rootKey must be a 16-byte Buffer/,
  );
});

test("rejects a masterKey that is not a 32-byte Buffer", () => {
  assert.throws(
    () => createWith({ rootKey: ROOT_KEY, masterKey: Buffer.alloc(16) }),
    /masterKey must be a 32-byte Buffer/,
  );
  assert.throws(
    () =>
      createWith({ rootKey: ROOT_KEY, masterKey: MASTER_KEY.toString("base64") }),
    /masterKey must be a 32-byte Buffer/,
  );
});

test("the master key handed to MapeoManager matches the pinned vector", () => {
  // Hex compare: the derived buffer is a sodium secure buffer, so it is
  // never deep-equal to a plain one even with identical bytes.
  const hex = MASTER_KEY.toString("hex");
  assert.equal(deriveMasterKeyFromRootKey(ROOT_KEY).toString("hex"), hex);
  assert.equal(new KeyManager(ROOT_KEY).getMasterKey().toString("hex"), hex);
});

// The pass-through is the whole point of the cache reaching MapeoManager: if
// it stops forwarding, every boot silently pays the derivation again inside
// the manager's own KeyManager, with nothing else failing.
test("forwards both keys to MapeoManager", async (t) => {
  const privateStorageDir = await mkdtemp(join(tmpdir(), "comapeo-manager-"));
  t.after(() => rm(privateStorageDir, { recursive: true, force: true }));

  /** @type {Record<string, unknown> | undefined} */
  let options;
  class FakeMapeoManager {
    /** @param {Record<string, unknown>} opts */
    constructor(opts) {
      options = opts;
    }
  }

  createWith({
    privateStorageDir,
    migrationsFolderPath: join(privateStorageDir, "drizzle"),
    rootKey: ROOT_KEY,
    masterKey: MASTER_KEY,
    managerClass: FakeMapeoManager,
  });

  assert.equal(options?.rootKey, ROOT_KEY);
  assert.equal(options?.masterKey, MASTER_KEY);
});

test("supplying the master key preserves the device identity", () => {
  // The guarantee the whole cache rests on: a KeyManager built from the
  // cached master key derives byte-identical keys to one that ran the
  // derivation, so no existing identity changes.
  const derived = new KeyManager(ROOT_KEY).getIdentityKeypair();
  const cached = new KeyManager(ROOT_KEY, {
    masterKey: MASTER_KEY,
  }).getIdentityKeypair();
  assert.deepEqual(cached.publicKey, derived.publicKey);
  assert.deepEqual(cached.secretKey, derived.secretKey);
});
