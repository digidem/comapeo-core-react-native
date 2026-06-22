import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

import { validateInit } from "./validate-init.mjs";
import { errorFrame } from "./error-frame.mjs";

/** Strict-base64 of 16 zero bytes: 22 chars + "==". */
const VALID_ROOT_KEY = Buffer.alloc(16).toString("base64");

test("a valid 16-byte base64 rootKey returns the decoded Buffer", () => {
  const { rootKey, error } = validateInit({ rootKey: VALID_ROOT_KEY });
  assert.equal(error, undefined);
  assert.ok(Buffer.isBuffer(rootKey));
  assert.equal(rootKey.byteLength, 16);
  assert.deepEqual(rootKey, Buffer.alloc(16));
});

test("a non-string rootKey returns an error", () => {
  for (const rootKey of [42, null, undefined, {}, ["x"], true]) {
    const { rootKey: out, error } = validateInit(
      /** @type {any} */ ({ rootKey }),
    );
    assert.equal(out, undefined);
    assert.ok(error instanceof Error);
    assert.match(error.message, /must be a base64 string/);
  }
});

test("a string that is not strict-base64-of-16-bytes returns an error", () => {
  // Too short, too long, and a non-standard-base64 string that
  // Buffer.from would otherwise silently truncate.
  for (const rootKey of ["", "deadbeef", "AAAA", "not-base64!!", "A".repeat(24)]) {
    const { rootKey: out, error } = validateInit({ rootKey });
    assert.equal(out, undefined, `expected error for ${JSON.stringify(rootKey)}`);
    assert.ok(error instanceof Error);
  }
});

test("a 22-char base64 string that decodes to the wrong length is rejected", () => {
  // Shape the regex accepts but length-checks catch belt-and-suspenders:
  // the regex pins 22+"==", so any accepted string decodes to 16 bytes.
  // This asserts the regex itself rejects a 24-byte-encoding string.
  const twentyFourBytes = Buffer.alloc(24).toString("base64");
  const { error } = validateInit({ rootKey: twentyFourBytes });
  assert.ok(error instanceof Error);
});

test("errorFrame builds the wire frame shape with phase routing", () => {
  const err = new Error("boom");
  const frame = errorFrame("construct", err);
  assert.deepEqual(frame, {
    type: "error",
    phase: "construct",
    message: "boom",
    stack: err.stack,
  });
});
