/**
 * RN-side scrubber + forbidden-metric filter.
 * Symmetric with the Node-side `backend/before-send.js` — keep both in
 * sync. The data-driven cases come from the shared
 * `test-support/scrubber-cases.js` table, run against both copies so the
 * two regex lists can't drift. Plain JS so expo-module-scripts'
 * babel-jest picks it up.
 */

const {
  scrubString,
  scrubUrlToHost,
  scrubEvent,
  scrubBreadcrumb,
  scrubLog,
  isForbiddenMetric,
} = require("../sentry-scrub");

const {
  scrubStringCases,
  scrubUrlToHostCases,
  forbiddenMetricCases,
} = require("../../test-support/scrubber-cases");

describe("shared scrubber cases (mirror of backend/before-send.js)", () => {
  test.each(scrubStringCases)("scrubString: $name", ({ input, expect: want }) => {
    expect(scrubString(input)).toBe(want);
  });

  test.each(scrubUrlToHostCases)("scrubUrlToHost: $name", ({ input, expect: want }) => {
    expect(scrubUrlToHost(input)).toBe(want);
  });

  test.each(forbiddenMetricCases)(
    "isForbiddenMetric: $name",
    ({ metricName, attributes, expect: want }) => {
      expect(isForbiddenMetric(metricName, attributes)).toBe(want);
    },
  );
});

describe("scrubEvent", () => {
  test("redacts numeric lat/lng stored as object fields", () => {
    const event = {
      extra: { coords: { latitude: 12.3456, longitude: -56.78 } },
      contexts: { geo: { lat: 1.0, lng: 2.0 } },
    };
    scrubEvent(event);
    expect(event.extra.coords.latitude).toBe("[redacted]");
    expect(event.extra.coords.longitude).toBe("[redacted]");
    expect(event.contexts.geo.lat).toBe("[redacted]");
    expect(event.contexts.geo.lng).toBe("[redacted]");
  });

  test("redacts rootKey-keyed object fields regardless of encoding", () => {
    // Hex value on purpose: key-based redaction must not depend on the
    // base64 wire encoding (the legacy app stored the key as hex).
    const event = {
      extra: { rootKey: "30313233343536373839616263646566" },
      contexts: { boot: { root_key: "MDEyMzQ1Njc4OWFiY2RlZg==", phase: "init" } },
    };
    scrubEvent(event);
    expect(event.extra.rootKey).toBe("[redacted]");
    expect(event.contexts.boot.root_key).toBe("[redacted]");
    expect(event.contexts.boot.phase).toBe("init");
  });

  test("reduces breadcrumb HTTP URLs to host-only", () => {
    const event = {
      breadcrumbs: [
        {
          category: "http",
          data: { url: "https://cloud.comapeo.app/projects/abc?token=x" },
        },
      ],
    };
    scrubEvent(event);
    expect(event.breadcrumbs[0].data.url).toBe("https://cloud.comapeo.app");
  });

  test("reduces request.url to host-only and scrubs marked query/headers", () => {
    const event = {
      request: {
        url: "https://cloud.comapeo.app/projects/abc?token=x",
        query_string: "rootKey=supersecretvalue",
        headers: { "x-secret": "root_key: supersecretvalue" },
      },
    };
    scrubEvent(event);
    expect(event.request.url).toBe("https://cloud.comapeo.app");
    expect(event.request.query_string).toMatch(/\[redacted\]/);
    expect(event.request.headers["x-secret"]).toMatch(/\[redacted\]/);
  });
});

describe("scrubBreadcrumb", () => {
  test("reduces http URL to host only", () => {
    const crumb = {
      category: "http",
      data: { url: "https://tiles.example.com/v1/12/34?key=abc" },
    };
    scrubBreadcrumb(crumb);
    expect(crumb.data.url).toBe("https://tiles.example.com");
  });

  test("does not stack-overflow on circular breadcrumb data", () => {
    const data = { a: 1 };
    data.self = data; // cycle
    const crumb = { category: "custom", data };
    expect(() => scrubBreadcrumb(crumb)).not.toThrow();
    expect(crumb.data.self).toBe("[Circular]");
  });
});

describe("scrubLog", () => {
  test("scrubs the message and attributes of a structured log", () => {
    const log = {
      message: "rootKey=supersecretvalue",
      attributes: { note: "latitude: 12.3", ok: "fine" },
    };
    scrubLog(log);
    expect(log.message).toMatch(/\[redacted\]/);
    expect(log.attributes.note).toBe("[redacted]");
    expect(log.attributes.ok).toBe("fine");
  });
});
