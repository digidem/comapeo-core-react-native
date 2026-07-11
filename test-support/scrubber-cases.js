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
  // Quoted-value forms — the realistic leak shapes. A logged init frame is
  // JSON; a console.warn'd message object is util.inspect-formatted. The
  // marker rule must reach the value through the opening quote.
  { name: "JSON-quoted rootKey value redacted (logged init frame)", input: `{"type":"init","rootKey":"${ROOTKEY_PADDED}"}`, expect: '{"type":"init","[redacted]"}' },
  { name: "util.inspect-quoted rootKey value redacted (logged message object)", input: `{ type: 'init', rootKey: '${ROOTKEY_PADDED}' }`, expect: "{ type: 'init', [redacted]' }" },
  { name: "root_key variant with quoted value redacted", input: `root_key: "${ROOTKEY_PADDED}"`, expect: "[redacted]\"" },
  // There is deliberately NO value-shape rule for bare (unmarked) tokens —
  // the key only ever exists next to its field name (covered above), and a
  // shape rule would be coupled to one encoding of the value. See the
  // SCRUB_PATTERNS note in src/sentry-scrub.ts.
  { name: "bare base64 token passes through", input: "token bm90LWEtcmVhbC1rZXktMQ done", expect: "token bm90LWEtcmVhbC1rZXktMQ done" },
  { name: `bare padded token passes through (no value-shape rule)`, input: `token ${ROOTKEY_PADDED} done`, expect: `token ${ROOTKEY_PADDED} done` },
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
  // Deliberately no value-shape rule for bare tokens (the `rootkey`
  // tag-NAME ban covers the realistic mistake) — token values pass.
  { name: "43-char token value allowed (no value-shape rule)", metricName: "comapeo.x", attributes: { bucket: BASE64_43 }, expect: false },
  { name: "52-char token value allowed (no value-shape rule)", metricName: "comapeo.x", attributes: { bucket: ZBASE32_52 }, expect: false },
  { name: "rootkey tag NAME drops the metric", metricName: "comapeo.x", attributes: { rootkey: "x" }, expect: true },
  { name: "ordinary rpc tags allowed", metricName: "comapeo.rpc.client.duration_ms", attributes: { method: "read.doc", status: "ok", platform: "ios" }, expect: false },
];
