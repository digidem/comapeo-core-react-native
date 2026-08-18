import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

import { masterKeyFrame } from "./master-key-frame.js";
import { parseInit } from "./parse-init.js";

// Same pinned vector as create-comapeo.test.mjs, so the frame this backend
// sends native is the one native can send back on the next boot.
const ROOT_KEY_B64 = Buffer.from(
  "000102030405060708090a0b0c0d0e0f",
  "hex",
).toString("base64");
const MASTER_KEY = Buffer.from(
  "bed4350c496024724d50592eb2cd4f61b3333ea871c495f63a4f687aed67f82c",
  "hex",
);

test("encodes the master key as strict base64", () => {
  const frame = masterKeyFrame(MASTER_KEY);

  assert.equal(frame.type, "master-key");
  assert.match(frame.masterKey, /^[A-Za-z0-9+/]{43}=$/);
});

test("round-trips through the init-frame validator", () => {
  const { masterKey } = masterKeyFrame(MASTER_KEY);

  const result = parseInit({ rootKey: ROOT_KEY_B64, masterKey });

  assert.equal(result.ok, true);
  assert.equal(result.masterKeyWarning, undefined);
  assert.deepEqual(result.masterKey, MASTER_KEY);
});

test("refuses anything that is not a 32-byte Buffer", () => {
  assert.throws(
    () => masterKeyFrame(Buffer.alloc(31)),
    /masterKey must be a 32-byte Buffer/,
  );
  assert.throws(
    () => masterKeyFrame(MASTER_KEY.toString("base64")),
    /masterKey must be a 32-byte Buffer/,
  );
});
