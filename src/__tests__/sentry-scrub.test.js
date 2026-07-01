/**
 * RN-side scrubber + forbidden-metric filter.
 * Symmetric with the Node-side `backend/before-send.js` — keep both in
 * sync. Plain JS so expo-module-scripts' babel-jest picks it up.
 */

const {
  scrubString,
  scrubUrlToHost,
  scrubEvent,
  scrubBreadcrumb,
  isForbiddenMetric,
} = require("../sentry-scrub");

// 32-byte keypair public key (43 base64url chars).
const BASE64_43 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
// ~52-char z-base-32 project id.
const ZBASE32_52 = "ybybybybybybybybybybybybybybybybybybybybybybybybybyb";

describe("scrubString", () => {
  test("redacts rootKey markers and lat/lng markers", () => {
    expect(scrubString("rootKey=aGVsbG8td29ybGQtMTIzNA")).toMatch(/\[redacted\]/);
    expect(scrubString("latitude: -12.345")).toMatch(/\[redacted\]/);
    expect(scrubString("hello world")).toBe("hello world");
  });

  // The broad base64-22 token rule is intentionally disabled pending a
  // narrower design (it over-matched trace_ids / exception type names /
  // metric tags). Until it returns, bare tokens pass through unredacted.
  test("does NOT redact bare base64 tokens while the broad rule is disabled", () => {
    expect(scrubString("token bm90LWEtcmVhbC1rZXktMQ done")).toBe(
      "token bm90LWEtcmVhbC1rZXktMQ done",
    );
    expect(scrubString(BASE64_43)).toBe(BASE64_43);
    expect(scrubString(ZBASE32_52)).toBe(ZBASE32_52);
  });
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
    // Values carry an explicit rootKey marker so the active patterns catch
    // them; a bare base64 token would currently pass through (broad rule off).
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
});

describe("scrubUrlToHost", () => {
  test("drops path + query", () => {
    expect(scrubUrlToHost("https://cloud.comapeo.app/projects/abc?token=x")).toBe(
      "https://cloud.comapeo.app",
    );
  });
});

describe("isForbiddenMetric", () => {
  test("drops forbidden tag names and lat/lng-shaped values", () => {
    expect(isForbiddenMetric("comapeo.x", { project_id: "p" })).toBe(true);
    expect(isForbiddenMetric("project_id", { platform: "ios" })).toBe(true);
    expect(isForbiddenMetric("comapeo.x", { coord: "lat=12.34" })).toBe(true);
    // Broad base64-22 value rule disabled (see sentry-scrub.ts); bare tokens
    // no longer drop the metric. Re-enable once a narrower rule lands.
    expect(isForbiddenMetric("comapeo.x", { bucket: BASE64_43 })).toBe(false);
    expect(isForbiddenMetric("comapeo.x", { bucket: ZBASE32_52 })).toBe(false);
    expect(
      isForbiddenMetric("comapeo.rpc.client.duration_ms", {
        method: "read.doc",
        status: "ok",
        platform: "ios",
      }),
    ).toBe(false);
  });
});
