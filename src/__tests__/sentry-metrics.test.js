/**
 * RN-side metrics layer (`src/sentry-metrics.ts`)
 * — the mirror of the tested backend `metrics.js`. A fake
 * `Sentry.metrics` records every emission so we can assert on the shared
 * `platform` injection, the single-metric device tags + usage-gated
 * `method` attribute, the forbidden-tag filter (exercising the REAL
 * `isForbiddenMetric`), and the off-switch.
 *
 * Plain JS so expo-module-scripts' babel-jest picks it up. Per-test
 * module reset because the layer reads `Platform.OS` and `sentryConfig`
 * at module-construction time.
 */

describe("sentry-metrics", () => {
  let calls;
  let isInitializedFlag;
  let prefs;

  beforeEach(() => {
    calls = [];
    isInitializedFlag = true;
    prefs = { diagnosticsEnabled: true, applicationUsageData: false };

    jest.resetModules();

    const recordCall = (name, value, data) =>
      calls.push({ name, value, ...(data?.attributes ? data.attributes : {}) });

    jest.doMock("react-native", () => ({ Platform: { OS: "android" } }));

    jest.doMock("@sentry/react-native", () => ({
      isInitialized: () => isInitializedFlag,
      metrics: {
        distribution: recordCall,
        count: recordCall,
        gauge: recordCall,
      },
    }));

    jest.doMock("../ComapeoCoreModule", () => ({
      readSentryPreferencesAtLaunch: () => prefs,
      readSentryConfig: () => ({
        deviceTags: { deviceClass: "mid", osMajor: "android.14" },
      }),
    }));
  });

  test("rpcClientMetric: usage on → one metric with method + status + device tags", () => {
    prefs.applicationUsageData = true;
    const { rpcClientMetric } = require("../sentry-metrics");
    rpcClientMetric("read.doc", "ok", 42);

    // One high-cardinality metric — no primary/mirror split. Slice by method
    // OR device_class (or both) with group-by at query time.
    expect(calls).toHaveLength(1);
    const [m] = calls;
    expect(m.name).toBe("comapeo.rpc.client.duration_ms");
    expect(m.platform).toBe("android");
    expect(m.status).toBe("ok");
    expect(m.method).toBe("read.doc");
    expect(m.device_class).toBe("mid");
    expect(m.os_major).toBe("android.14");
  });

  test("rpcClientMetric: usage off → same metric, method dropped (privacy gate)", () => {
    const { rpcClientMetric } = require("../sentry-metrics");
    rpcClientMetric("read.doc", "ok", 42);

    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("comapeo.rpc.client.duration_ms");
    expect(calls[0].method).toBeUndefined();
    expect(calls[0].status).toBe("ok");
    expect(calls[0].device_class).toBe("mid");
    expect(calls[0].os_major).toBe("android.14");
  });

  test("platform is injected on every primitive", () => {
    const { __metricsInternals } = require("../sentry-metrics");
    __metricsInternals.count("comapeo.x", { a: "1" });
    __metricsInternals.distribution("comapeo.y", 1, "millisecond", { b: "2" });
    __metricsInternals.gauge("comapeo.z", 1, "byte", { c: "3" });
    expect(calls).toHaveLength(3);
    for (const call of calls) expect(call.platform).toBe("android");
  });

  test("forbidden tag VALUE and NAME are dropped", () => {
    const { __metricsInternals } = require("../sentry-metrics");
    __metricsInternals.count("comapeo.x", { coord: "lat=12.34" }); // forbidden value shape
    expect(calls).toHaveLength(0);
    __metricsInternals.count("comapeo.x", { project_id: "p" }); // forbidden name
    expect(calls).toHaveLength(0);
    __metricsInternals.count("comapeo.x", { method: "read.doc" }); // allowed
    expect(calls).toHaveLength(1);
  });

  // Deliberately no value-shape rule for bare tokens (see the
  // SCRUB_PATTERNS note in sentry-scrub.ts) — the `rootkey` tag-NAME ban
  // covers the realistic mistake, so a bare token tag value passes.
  test("bare base64 tag values pass through (no value-shape rule)", () => {
    const { __metricsInternals } = require("../sentry-metrics");
    __metricsInternals.count("comapeo.x", { bucket: "bm90LWEtcmVhbC1rZXktMQ" });
    expect(calls).toHaveLength(1);
  });

  test("all helpers no-op when Sentry is not initialized", () => {
    isInitializedFlag = false;
    const { rpcClientMetric, __metricsInternals } = require("../sentry-metrics");
    rpcClientMetric("read.doc", "ok", 1);
    __metricsInternals.count("comapeo.x", { method: "read.doc" });
    expect(calls).toHaveLength(0);
  });

  test("rpcStatusFor classifies failures (never ok, even for a falsy reason)", () => {
    const { rpcStatusFor } = require("../sentry-metrics");
    // Only the reject path calls this; the success path records "ok" directly.
    expect(rpcStatusFor(Object.assign(new Error("x"), { name: "TimeoutError" }))).toBe(
      "timeout",
    );
    expect(rpcStatusFor(new Error("boom"))).toBe("error");
    // A falsy rejection reason is still a failure, not a silent "ok".
    expect(rpcStatusFor(null)).toBe("error");
    expect(rpcStatusFor(0)).toBe("error");
    expect(rpcStatusFor("")).toBe("error");
  });
});
