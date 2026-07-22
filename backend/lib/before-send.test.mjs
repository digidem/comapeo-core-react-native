import { test } from "node:test";
import assert from "node:assert/strict";

import {
  scrubString,
  scrubUrlToHost,
  scrubEvent,
  scrubBreadcrumb,
  scrubLog,
  isForbiddenMetric,
} from "../before-send.js";

import {
  scrubStringCases,
  scrubUrlToHostCases,
  forbiddenMetricCases,
} from "../../test-support/scrubber-cases.js";

/**
 * Node-side scrubber + forbidden-metric filter.
 * Symmetric with the RN-side `src/sentry-scrub.ts` — the data-driven cases
 * come from the shared `test-support/scrubber-cases.js` table, run against
 * both copies so the two regex lists can't drift.
 */

for (const { name, input, expect } of scrubStringCases) {
  test(`scrubString: ${name}`, () => {
    assert.equal(scrubString(input), expect);
  });
}

for (const { name, input, expect } of scrubUrlToHostCases) {
  test(`scrubUrlToHost: ${name}`, () => {
    assert.equal(scrubUrlToHost(input), expect);
  });
}

for (const { name, metricName, attributes, expect } of forbiddenMetricCases) {
  test(`isForbiddenMetric: ${name}`, () => {
    assert.equal(isForbiddenMetric(metricName, attributes), expect);
  });
}

test("scrubEvent redacts numeric lat/lng stored as object fields", () => {
  const event = {
    extra: { coords: { latitude: 12.3456, longitude: -56.78 } },
    contexts: { geo: { lat: 1.0, lng: 2.0 } },
  };
  scrubEvent(event);
  assert.equal(event.extra.coords.latitude, "[redacted]");
  assert.equal(event.extra.coords.longitude, "[redacted]");
  assert.equal(event.contexts.geo.lat, "[redacted]");
  assert.equal(event.contexts.geo.lng, "[redacted]");
});

test("scrubEvent redacts rootKey-keyed object fields regardless of encoding", () => {
  // Hex value on purpose: key-based redaction must not depend on the
  // base64 wire encoding (the legacy app stored the key as hex).
  const event = {
    extra: { rootKey: "30313233343536373839616263646566" },
    contexts: { boot: { root_key: "MDEyMzQ1Njc4OWFiY2RlZg==", phase: "init" } },
  };
  scrubEvent(event);
  assert.equal(event.extra.rootKey, "[redacted]");
  assert.equal(event.contexts.boot.root_key, "[redacted]");
  assert.equal(event.contexts.boot.phase, "init");
});

test("scrubEvent reduces request.url to host-only and scrubs marked query/headers", () => {
  const event = {
    request: {
      url: "https://cloud.comapeo.app/projects/abc?token=x",
      query_string: "rootKey=supersecretvalue",
      headers: { "x-secret": "root_key: supersecretvalue" },
    },
  };
  scrubEvent(event);
  assert.equal(event.request.url, "https://cloud.comapeo.app");
  assert.match(event.request.query_string, /\[redacted\]/);
  assert.match(event.request.headers["x-secret"], /\[redacted\]/);
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

test("scrubBreadcrumb does not stack-overflow on circular data", () => {
  const data = { a: 1 };
  data.self = data; // cycle
  const crumb = { category: "custom", data };
  assert.doesNotThrow(() => scrubBreadcrumb(crumb));
  assert.equal(crumb.data.self, "[Circular]");
});

test("scrubLog scrubs the message and attributes of a structured log", () => {
  const log = {
    message: "rootKey=supersecretvalue",
    attributes: { note: "latitude: 12.3", ok: "fine" },
  };
  scrubLog(log);
  assert.match(log.message, /\[redacted\]/);
  assert.equal(log.attributes.note, "[redacted]");
  assert.equal(log.attributes.ok, "fine");
});
