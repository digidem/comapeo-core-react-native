import { test } from "node:test";
import assert from "node:assert/strict";

import {
  scrubString,
  scrubUrlToHost,
  scrubEvent,
  scrubBreadcrumb,
  isForbiddenMetric,
} from "../before-send.js";

/**
 * Node-side scrubber (§9b.1 / §9b.5) + forbidden-metric filter (§11.8).
 * Symmetric with the RN-side `src/sentry-scrub.ts` — keep both in sync.
 */

test("scrubString redacts base64-22, lat/lng markers, and rootKey", () => {
  assert.match(scrubString("rootKey=aGVsbG8td29ybGQtMTIzNA"), /\[redacted\]/);
  // Bare 22-char base64 token.
  assert.match(scrubString("token bm90LWEtcmVhbC1rZXktMQ done"), /\[redacted\]/);
  assert.match(scrubString("latitude: -12.345"), /\[redacted\]/);
  assert.match(scrubString("lng=120.5"), /\[redacted\]/);
  // A normal sentence with no markers is left intact.
  assert.equal(scrubString("hello world"), "hello world");
});

test("scrubUrlToHost drops path + query (§9b.5)", () => {
  assert.equal(
    scrubUrlToHost("https://cloud.comapeo.app/projects/abc?token=secret"),
    "https://cloud.comapeo.app",
  );
  // Non-URL falls back to string scrubbing.
  assert.equal(scrubUrlToHost("not a url"), "not a url");
});

test("scrubEvent walks message, exception, extra, breadcrumbs, spans", () => {
  const event = {
    message: "lat=1.0",
    exception: { values: [{ type: "Error", value: "rootKey=aGVsbG8td29ybGQtMTIzNA" }] },
    extra: { note: "lng=2.0" },
    contexts: { custom: { coord: "latitude: 9.9" } },
    breadcrumbs: [
      {
        category: "http",
        data: { url: "https://x.example/path?q=1" },
        message: "lng=3.0",
      },
    ],
    spans: [{ description: "lat=4.0", data: { extra: "longitude: 5.0" } }],
  };
  scrubEvent(event);
  assert.match(event.message, /\[redacted\]/);
  assert.match(event.exception.values[0].value, /\[redacted\]/);
  assert.match(event.extra.note, /\[redacted\]/);
  assert.match(event.contexts.custom.coord, /\[redacted\]/);
  assert.equal(event.breadcrumbs[0].data.url, "https://x.example");
  assert.match(event.breadcrumbs[0].message, /\[redacted\]/);
  assert.match(event.spans[0].description, /\[redacted\]/);
  assert.match(event.spans[0].data.extra, /\[redacted\]/);
});

test("scrubBreadcrumb reduces http URL to host only", () => {
  const crumb = {
    category: "http",
    data: { url: "https://tiles.example.com/v1/12/34?key=abc" },
  };
  scrubBreadcrumb(crumb);
  assert.equal(crumb.data.url, "https://tiles.example.com");
});

test("isForbiddenMetric drops forbidden tag names and base64-22 values", () => {
  assert.equal(isForbiddenMetric("comapeo.x", { project_id: "p" }), true);
  assert.equal(isForbiddenMetric("project_id", { platform: "ios" }), true);
  assert.equal(
    isForbiddenMetric("comapeo.x", { bucket: "bm90LWEtcmVhbC1rZXktMQ" }),
    true,
  );
  assert.equal(
    isForbiddenMetric("comapeo.rpc.server.duration_ms", {
      method: "read.doc",
      status: "ok",
      platform: "ios",
    }),
    false,
  );
});
