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
 * `serializeEnvelope` is injected so callers control whether
 * `@sentry/core` gets loaded; this module has no static dep on it.
 *
 * @param {any} envelope
 * @param {(env: any) => string | Uint8Array} serializeEnvelope
 * @returns {{type: "sentry-event", payload: any} | {type: "sentry-envelope", data: string}}
 */
export function envelopeToFrame(envelope, serializeEnvelope) {
  const items = envelope[1];
  if (Array.isArray(items) && items.length === 1) {
    const [itemHeader, payload] = items[0];
    if (itemHeader && itemHeader.type === "event") {
      return { type: "sentry-event", payload };
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
