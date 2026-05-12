import { test } from "node:test";
import assert from "node:assert/strict";

import { envelopeToFrame } from "./sentry-frame.js";

/**
 * Build a minimal Sentry-shaped envelope tuple. The real SDK uses
 * `createEnvelope` from `@sentry/core`, but our routing only inspects
 * `envelope[1][i][0].type` and the matching payload, so a hand-rolled
 * fixture is enough and avoids pulling the SDK into the test.
 *
 * @param {Array<[Record<string, any>, any]>} items
 */
function envelope(items) {
  return [{ sent_at: new Date().toISOString() }, items];
}

/**
 * Stand-in for `@sentry/core`'s `serializeEnvelope`.
 * @param {any} env
 */
function fakeSerializeEnvelope(env) {
  return JSON.stringify(env);
}

test("single-item event envelope routes as sentry-event with raw payload", () => {
  const payload = {
    event_id: "abc",
    level: "error",
    exception: { values: [{ type: "Error", value: "boom" }] },
  };
  const env = envelope([[{ type: "event", length: 0 }, payload]]);

  const frame = envelopeToFrame(env, fakeSerializeEnvelope);

  assert.equal(frame.type, "sentry-event");
  // Same reference — no copy, no JSON round-trip on this path.
  assert.equal(frame.payload, payload);
});

test("transaction envelope routes as sentry-envelope (no transaction decoder on iOS)", () => {
  const env = envelope([
    [{ type: "transaction", length: 0 }, { event_id: "t1", type: "transaction" }],
  ]);

  const frame = envelopeToFrame(env, fakeSerializeEnvelope);

  assert.equal(frame.type, "sentry-envelope");
  // Base64 of the serialised envelope round-trips back to the input.
  const decoded = JSON.parse(
    Buffer.from(frame.data, "base64").toString("utf-8"),
  );
  assert.deepEqual(decoded, env);
});

test("session envelope routes as sentry-envelope", () => {
  const env = envelope([
    [{ type: "session", length: 0 }, { sid: "s1", status: "ok" }],
  ]);
  const frame = envelopeToFrame(env, fakeSerializeEnvelope);
  assert.equal(frame.type, "sentry-envelope");
});

test("check-in envelope routes as sentry-envelope", () => {
  const env = envelope([[{ type: "check_in", length: 0 }, { id: "c1" }]]);
  const frame = envelopeToFrame(env, fakeSerializeEnvelope);
  assert.equal(frame.type, "sentry-envelope");
});

test("event-plus-attachment routes as sentry-envelope (multi-item)", () => {
  // The event path is reserved for SINGLE-item envelopes — attachments
  // would be dropped if we tried to extract just the event payload.
  const env = envelope([
    [{ type: "event", length: 0 }, { event_id: "e1" }],
    [{ type: "attachment", length: 5 }, "hello"],
  ]);

  const frame = envelopeToFrame(env, fakeSerializeEnvelope);

  assert.equal(frame.type, "sentry-envelope");
});

test("Uint8Array serialised output is base64-encoded as-is", () => {
  const env = envelope([[{ type: "transaction", length: 0 }, { event_id: "t1" }]]);
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const frame = envelopeToFrame(env, () => bytes);
  assert.equal(frame.type, "sentry-envelope");
  assert.equal(Buffer.from(frame.data, "base64").toString("hex"), "0102030405");
});

test("empty envelope (no items) routes as sentry-envelope", () => {
  // Defensive — Sentry shouldn't emit one, but the routing shouldn't
  // throw on it. Anything that isn't a single-item event-envelope
  // falls through to the envelope path.
  const env = envelope([]);
  const frame = envelopeToFrame(env, fakeSerializeEnvelope);
  assert.equal(frame.type, "sentry-envelope");
});
