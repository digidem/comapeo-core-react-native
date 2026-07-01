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

/** `scrubString(input)` must equal `expect`. */
export const scrubStringCases = [
  { name: "rootKey marker (no delimiter) → whole value redacted", input: "rootKey=aGVsbG8td29ybGQtMTIzNA", expect: "[redacted]" },
  { name: "latitude marker redacted", input: "latitude: -12.345", expect: "[redacted]" },
  { name: "lng marker redacted", input: "lng=120.5", expect: "[redacted]" },
  // Greedy-regex regression: the value stops at the first field delimiter, so
  // co-located fields in a compact string survive.
  { name: "rootKey value stops at comma delimiter", input: "rootKey=abc,method=obs.create,code=500", expect: "[redacted],method=obs.create,code=500" },
  { name: "plain sentence untouched", input: "hello world", expect: "hello world" },
  // Broad base64-22 rule is intentionally disabled — bare tokens pass through.
  { name: "bare base64 token passes through", input: "token bm90LWEtcmVhbC1rZXktMQ done", expect: "token bm90LWEtcmVhbC1rZXktMQ done" },
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
  // Broad base64-22 value rule disabled — bare tokens no longer drop a metric.
  { name: "43-char token value allowed (broad rule off)", metricName: "comapeo.x", attributes: { bucket: BASE64_43 }, expect: false },
  { name: "52-char token value allowed (broad rule off)", metricName: "comapeo.x", attributes: { bucket: ZBASE32_52 }, expect: false },
  { name: "ordinary rpc tags allowed", metricName: "comapeo.rpc.client.duration_ms", attributes: { method: "read.doc", status: "ok", platform: "ios" }, expect: false },
];
