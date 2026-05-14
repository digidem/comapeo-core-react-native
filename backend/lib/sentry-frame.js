import { serializeEnvelope } from "@sentry/core";

/**
 * Routes a Sentry envelope into one of two control-socket frame
 * shapes that the native side knows how to consume:
 *
 *   - `sentry-event`: a single-item, error-event envelope. The
 *     payload is forwarded as-is and the native SDK reconstructs
 *     it via its event decoder, so capture goes through
 *     `Sentry.captureEvent` and the native scope (device, OS,
 *     app, user, native breadcrumbs) merges at capture time.
 *   - `sentry-envelope`: anything else (transactions, sessions,
 *     check-ins, profiles, multi-item event payloads, attachments).
 *     The whole envelope is serialised + base64-encoded; native
 *     hands the bytes to its hybrid envelope-capture entrypoint.
 *     No scope merge here — irrelevant for these item types.
 *
 * @param {any} envelope
 * @returns {{type: "sentry-event", payload: any} | {type: "sentry-envelope", data: string}}
 */
export function envelopeToFrame(envelope) {
  const items = envelope[1];
  if (Array.isArray(items) && items.length === 1) {
    const [itemHeader, payload] = items[0];
    if (itemHeader && itemHeader.type === "event") {
      return { type: "sentry-event", payload };
    }
  }
  // `@sentry/core`'s `serializeEnvelope` doesn't set `length` on item
  // headers (the field is optional per the Sentry envelope spec).
  // But sentry-android's `EnvelopeReader.read` REQUIRES `length > 0` —
  // without it the receive side throws "Item header at index 'N' is
  // null or empty" and discards the envelope. Stamp the byte length
  // explicitly so the receiver can parse.
  if (Array.isArray(items)) {
    for (const item of items) {
      const [itemHeader, payload] = item;
      if (itemHeader && itemHeader.length == null) {
        itemHeader.length = byteLengthOfPayload(payload);
      }
    }
  }
  const serialized = serializeEnvelope(envelope);
  const bytes =
    typeof serialized === "string"
      ? Buffer.from(serialized, "utf-8")
      : Buffer.from(serialized);
  return {
    type: "sentry-envelope",
    data: bytes.toString("base64"),
  };
}

/**
 * @param {any} payload
 * @returns {number}
 */
function byteLengthOfPayload(payload) {
  if (typeof payload === "string") {
    return Buffer.byteLength(payload, "utf-8");
  }
  if (payload instanceof Uint8Array) {
    return payload.byteLength;
  }
  // `serializeEnvelope` JSON-stringifies object payloads with the
  // same default options, so this matches the bytes it'll emit.
  return Buffer.byteLength(JSON.stringify(payload), "utf-8");
}
