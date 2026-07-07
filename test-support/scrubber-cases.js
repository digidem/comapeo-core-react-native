/**
 * Shared scrubber test cases, exercised against BOTH copies of the mirrored
 * scrubber — `src/sentry-scrub.ts` (RN, via jest) and `backend/before-send.js`
 * (Node, via node:test). Importing one table into both suites is what keeps the
 * two regex lists from drifting: a change to one copy that isn't mirrored fails
 * here. Pure data only (no test framework) so either runner can consume it.
 */

// 32-byte keypair public key (43 base64url chars).
export const BASE64_43 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
// ~52-char z-base-32 project id.
export const ZBASE32_52 =
  "ybybybybybybybybybybybybybybybybybybybybybybybybybyb";
// 16-byte rootkey in the wire format `backend/index.js` enforces:
// 22 base64 chars + `==` (base64 of the ASCII bytes "0123456789abcdef").
export const ROOTKEY_PADDED = "MDEyMzQ1Njc4OWFiY2RlZg==";

/** `scrubString(input)` must equal `expect`. */
export const scrubStringCases = [
  { name: "rootKey marker (no delimiter) → whole value redacted", input: "rootKey=aGVsbG8td29ybGQtMTIzNA", expect: "[redacted]" },
  { name: "latitude marker redacted", input: "latitude: -12.345", expect: "[redacted]" },
  { name: "lng marker redacted", input: "lng=120.5", expect: "[redacted]" },
  // `lon` is the field name @comapeo/schema observations actually use.
  { name: "lon marker redacted", input: "lon=-55.1234", expect: "[redacted]" },
  // JSON-stringified coordinates: the closing quote sits between key and
  // separator (`"lat":`), which the pre-quote-handling regex missed.
  { name: "JSON-serialized coordinates redacted", input: '{"lat":-12.345,"lon":55.2}', expect: '{"[redacted],"[redacted]}' },
  // Greedy-regex regression: the value stops at the first field delimiter, so
  // co-located fields in a compact string survive.
  { name: "rootKey value stops at comma delimiter", input: "rootKey=abc,method=obs.create,code=500", expect: "[redacted],method=obs.create,code=500" },
  { name: "plain sentence untouched", input: "hello world", expect: "hello world" },
  // Bare (unmarked) rootkey-shaped tokens: exact-length base64-22 rule.
  { name: "bare padded rootkey (wire format) redacted", input: `boot got key ${ROOTKEY_PADDED} from native`, expect: "boot got key [redacted] from native" },
  { name: "bare unpadded rootkey-shaped token redacted", input: "token bm90LWEtcmVhbC1rZXktMQ done", expect: "token [redacted] done" },
  // The marker rule can't reach a JSON-quoted value (quote delimits it);
  // the bare rule catches the token inside the quotes.
  { name: "JSON-quoted rootkey value redacted by bare rule", input: `{"rootKey":"${ROOTKEY_PADDED}"}`, expect: '{"rootKey":"[redacted]"}' },
  // Shapes the disabled broad rule over-matched — must all survive.
  { name: "32-hex trace id and 16-hex span id survive", input: "trace 4bf92f3577b34da6a3ce929d0e0e4736 span 00f067aa0ba902b7", expect: "trace 4bf92f3577b34da6a3ce929d0e0e4736 span 00f067aa0ba902b7" },
  { name: "exception type names survive", input: "NotFoundError: caused by TypeError", expect: "NotFoundError: caused by TypeError" },
  // 22 letters ending in [AQgw] — only the character-mix check spares it.
  { name: "22-char PascalCase identifier survives", input: "handled ProjectInviteTokenView event", expect: "handled ProjectInviteTokenView event" },
  // 22 chars, right final char, mixed case + digits — the hex check spares it.
  { name: "22-char hex fragment survives", input: "id deadbeefDEADBEEF0011AA end", expect: "id deadbeefDEADBEEF0011AA end" },
  { name: "22-char ERR_* code survives", input: "ERR_INVALID_URL_SCHEME", expect: "ERR_INVALID_URL_SCHEME" },
  // Exact-length rule ignores base64-ish tokens of other lengths.
  { name: "43-char public key passes through", input: BASE64_43, expect: BASE64_43 },
  { name: "52-char project id passes through", input: ZBASE32_52, expect: ZBASE32_52 },
];

/** `scrubUrlToHost(input)` must equal `expect`. */
export const scrubUrlToHostCases = [
  { name: "absolute URL → scheme + host only", input: "https://cloud.comapeo.app/projects/abc?token=secret", expect: "https://cloud.comapeo.app" },
  { name: "absolute tile URL → host only", input: "https://tiles.example.com/v1/12/34?key=abc", expect: "https://tiles.example.com" },
  // Relative-URL regression: new URL() throws, so drop the query (where the
  // token rides) rather than falling back to a no-op.
  { name: "relative URL drops query token", input: "/v1/projects?access_token=SECRET", expect: "/v1/projects" },
  { name: "relative URL drops fragment", input: "/a/b#frag", expect: "/a/b" },
  { name: "plain non-URL passes through", input: "not a url", expect: "not a url" },
];

/** `isForbiddenMetric(name, attributes)` must equal `expect`. */
export const forbiddenMetricCases = [
  { name: "forbidden tag name in attributes", metricName: "comapeo.x", attributes: { project_id: "p" }, expect: true },
  { name: "forbidden metric name", metricName: "project_id", attributes: { platform: "ios" }, expect: true },
  { name: "lat/lng-shaped tag value", metricName: "comapeo.x", attributes: { coord: "lat=12.34" }, expect: true },
  { name: "lon-shaped tag value", metricName: "comapeo.x", attributes: { coord: "lon=-55.12" }, expect: true },
  { name: "bare rootkey-shaped tag value drops the metric", metricName: "comapeo.x", attributes: { note: `key ${ROOTKEY_PADDED}` }, expect: true },
  { name: "error_class tag value allowed", metricName: "comapeo.rpc.errors", attributes: { error_class: "NotFoundError" }, expect: false },
  { name: "trace-id tag value allowed", metricName: "comapeo.x", attributes: { trace: "4bf92f3577b34da6a3ce929d0e0e4736" }, expect: false },
  // Exact-length rule ignores base64-ish tokens of other lengths.
  { name: "43-char token value allowed", metricName: "comapeo.x", attributes: { bucket: BASE64_43 }, expect: false },
  { name: "52-char token value allowed", metricName: "comapeo.x", attributes: { bucket: ZBASE32_52 }, expect: false },
  { name: "ordinary rpc tags allowed", metricName: "comapeo.rpc.client.duration_ms", attributes: { method: "read.doc", status: "ok", platform: "ios" }, expect: false },
];
