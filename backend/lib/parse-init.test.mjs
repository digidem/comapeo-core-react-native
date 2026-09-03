import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

import { parseInit } from "./parse-init.js";

/**
 * Validation matrix for the control-socket `init` payload. The asymmetry
 * under test: a bad `rootKey` fails the parse (index.js turns that into a
 * fatal), a bad `masterKey` only warns and drops the cache.
 */

const ROOT_KEY_B64 = Buffer.alloc(16, 3).toString("base64");
const MASTER_KEY_B64 = Buffer.alloc(32, 4).toString("base64");

/**
 * @param {Record<string, unknown>} message
 * @returns {Extract<ReturnType<typeof parseInit>, { ok: true }>}
 */
function parseOk(message) {
  const result = parseInit(message);
  // `=== false`, not `!ok`: truthiness doesn't narrow a JSDoc union.
  if (result.ok === false) {
    assert.fail(`expected a valid init: ${result.error.message}`);
  }
  return result;
}

/**
 * @param {Record<string, unknown>} message
 * @returns {Error}
 */
function parseError(message) {
  const result = parseInit(message);
  if (result.ok === true) assert.fail("expected a parse failure");
  return result.error;
}

test("accepts a rootKey-only frame", () => {
  const result = parseOk({ type: "init", rootKey: ROOT_KEY_B64 });
  assert.deepEqual(result.rootKey, Buffer.alloc(16, 3));
  assert.equal(result.masterKey, undefined);
  assert.equal(result.masterKeyWarning, undefined);
});

test("accepts a frame carrying both keys", () => {
  const result = parseOk({
    type: "init",
    rootKey: ROOT_KEY_B64,
    masterKey: MASTER_KEY_B64,
  });
  assert.deepEqual(result.masterKey, Buffer.alloc(32, 4));
  assert.equal(result.masterKeyWarning, undefined);
});

test("rejects a missing rootKey", () => {
  const error = parseError({ type: "init" });
  assert.match(error.message, /init\.rootKey must be a base64 string/);
});

test("rejects a rootKey that is not strict-base64", () => {
  const error = parseError({ type: "init", rootKey: "not-base64" });
  assert.match(error.message, /init\.rootKey is not strict-base64 of 16 bytes/);
});

test("rejects a rootKey whose base64 is the wrong size", () => {
  const error = parseError({
    type: "init",
    rootKey: Buffer.alloc(32, 1).toString("base64"),
  });
  assert.match(error.message, /init\.rootKey is not strict-base64 of 16 bytes/);
});

// 22 chars + "==" passes the regex, but the last character's 4 unused bits are
// set, so it is a second spelling of a key native would have spelled another
// way. A plain length check can never see this.
test("rejects a rootKey that does not round-trip", () => {
  const error = parseError({ type: "init", rootKey: `${"A".repeat(21)}B==` });
  assert.match(error.message, /round trip/);
});

test("warns and drops a non-string masterKey", () => {
  const result = parseOk({ type: "init", rootKey: ROOT_KEY_B64, masterKey: 7 });
  assert.equal(result.masterKey, undefined);
  assert.equal(result.masterKeyWarning?.reason, "type");
});

test("warns and drops a masterKey that is not strict base64", () => {
  const result = parseOk({
    type: "init",
    rootKey: ROOT_KEY_B64,
    masterKey: "not base64 at all!!!",
  });
  assert.equal(result.masterKey, undefined);
  assert.equal(result.masterKeyWarning?.reason, "encoding");
});

test("warns and drops a masterKey whose base64 is the wrong size", () => {
  const result = parseOk({
    type: "init",
    rootKey: ROOT_KEY_B64,
    masterKey: Buffer.alloc(16, 4).toString("base64"),
  });
  assert.equal(result.masterKey, undefined);
  assert.equal(result.masterKeyWarning?.reason, "encoding");
});

test("warns and drops a masterKey that does not round-trip", () => {
  const result = parseOk({
    type: "init",
    rootKey: ROOT_KEY_B64,
    masterKey: `${"A".repeat(42)}B=`,
  });
  assert.equal(result.masterKey, undefined);
  assert.equal(result.masterKeyWarning?.reason, "trailing-bits");
});

test("keeps key material out of the warning message", () => {
  const masterKey = `${MASTER_KEY_B64}extra`;
  const result = parseOk({ type: "init", rootKey: ROOT_KEY_B64, masterKey });
  const warning = result.masterKeyWarning?.message ?? "";
  assert.ok(!warning.includes(masterKey));
  assert.ok(!warning.includes(MASTER_KEY_B64.slice(0, 8)));
});
