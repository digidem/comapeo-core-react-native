/**
 * RN-side scrubber (§9b.1 / §9b.5) + forbidden-metric filter (§11.8).
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
  test("redacts base64-22, lat/lng markers, and rootKey", () => {
    expect(scrubString("rootKey=aGVsbG8td29ybGQtMTIzNA")).toMatch(/\[redacted\]/);
    expect(scrubString("token bm90LWEtcmVhbC1rZXktMQ done")).toMatch(/\[redacted\]/);
    expect(scrubString("latitude: -12.345")).toMatch(/\[redacted\]/);
    expect(scrubString("hello world")).toBe("hello world");
  });

  test("redacts base64url longer than 22 chars", () => {
    expect(scrubString(BASE64_43)).toBe("[redacted]");
    expect(scrubString(ZBASE32_52)).toBe("[redacted]");
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

  test("reduces request.url to host-only and scrubs query/headers", () => {
    const event = {
      request: {
        url: "https://cloud.comapeo.app/projects/abc?token=x",
        query_string: `key=${BASE64_43}`,
        headers: { "x-secret": BASE64_43 },
      },
    };
    scrubEvent(event);
    expect(event.request.url).toBe("https://cloud.comapeo.app");
    expect(event.request.query_string).toMatch(/\[redacted\]/);
    expect(event.request.headers["x-secret"]).toBe("[redacted]");
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
  test("drops forbidden tag names and long base64 values", () => {
    expect(isForbiddenMetric("comapeo.x", { project_id: "p" })).toBe(true);
    expect(isForbiddenMetric("project_id", { platform: "ios" })).toBe(true);
    expect(isForbiddenMetric("comapeo.x", { bucket: BASE64_43 })).toBe(true);
    expect(isForbiddenMetric("comapeo.x", { bucket: ZBASE32_52 })).toBe(true);
    expect(
      isForbiddenMetric("comapeo.rpc.client.duration_ms", {
        method: "read.doc",
        status: "ok",
        platform: "ios",
      }),
    ).toBe(false);
  });
});
