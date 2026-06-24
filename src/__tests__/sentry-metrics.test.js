/**
 * RN-side metrics layer (`src/sentry-metrics.ts`, §11.2 / §11.6 / §11.8)
 * — the mirror of the tested backend `metrics.js`. A fake
 * `Sentry.metrics` records every emission so we can assert on the shared
 * `platform` injection, the `.by_device` cardinality split, the
 * forbidden-tag filter (exercising the REAL `isForbiddenMetric`), the
 * off-switch, and the usage gating.
 *
 * Plain JS so expo-module-scripts' babel-jest picks it up. Per-test
 * module reset because the layer reads `Platform.OS` and `sentryConfig`
 * at module-construction time.
 */

describe("sentry-metrics", () => {
  let calls;
  let prefs;
  let isInitializedFlag;

  beforeEach(() => {
    calls = [];
    prefs = { diagnosticsEnabled: false, applicationUsageData: false };
    isInitializedFlag = true;

    jest.resetModules();

    const recordCall = (name, value, data) =>
      calls.push({ name, value, ...(data?.attributes ? data.attributes : {}) });

    jest.doMock("react-native", () => ({ Platform: { OS: "android" } }));

    jest.doMock("@sentry/react-native", () => ({
      isInitialized: () => isInitializedFlag,
      addBreadcrumb: jest.fn(),
      metrics: {
        distribution: recordCall,
        count: recordCall,
        gauge: recordCall,
      },
    }));

    jest.doMock("../sentry", () => ({
      sentryConfig: {
        deviceTags: { deviceClass: "mid", osMajor: "android.14" },
      },
    }));

    jest.doMock("../ComapeoCoreModule", () => ({
      readSentryPreferences: () => prefs,
    }));
  });

  test("rpcClientMetric: primary carries method, by_device carries device tags", () => {
    const { rpcClientMetric } = require("../sentry-metrics");
    rpcClientMetric("read.doc", "ok", 42);

    expect(calls).toHaveLength(2);
    const [primary, mirror] = calls;

    expect(primary.name).toBe("comapeo.rpc.client.duration_ms");
    expect(primary.platform).toBe("android");
    expect(primary.method).toBe("read.doc");
    expect(primary.status).toBe("ok");
    expect(primary.device_class).toBeUndefined();
    expect(primary.os_major).toBeUndefined();

    expect(mirror.name).toBe("comapeo.rpc.client.duration_ms.by_device");
    expect(mirror.platform).toBe("android");
    expect(mirror.status).toBe("ok");
    expect(mirror.device_class).toBe("mid");
    expect(mirror.os_major).toBe("android.14");
    expect(mirror.method).toBeUndefined();
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
    __metricsInternals.count("comapeo.x", { bucket: "bm90LWEtcmVhbC1rZXktMQ" });
    expect(calls).toHaveLength(0);
    __metricsInternals.count("comapeo.x", { project_id: "p" });
    expect(calls).toHaveLength(0);
    __metricsInternals.count("comapeo.x", { method: "read.doc" });
    expect(calls).toHaveLength(1);
  });

  test("all helpers no-op when Sentry is not initialized", () => {
    isInitializedFlag = false;
    const { rpcClientMetric, __metricsInternals } = require("../sentry-metrics");
    rpcClientMetric("read.doc", "ok", 1);
    __metricsInternals.count("comapeo.x", { method: "read.doc" });
    expect(calls).toHaveLength(0);
  });

  test("recordUsage no-ops unless diagnostics + usage data are both on", () => {
    const Sentry = require("@sentry/react-native");
    const { recordUsage } = require("../sentry-metrics");

    recordUsage.screen("Map");
    recordUsage.feature("export");
    expect(calls).toHaveLength(0);
    expect(Sentry.addBreadcrumb).not.toHaveBeenCalled();

    prefs.diagnosticsEnabled = true;
    prefs.applicationUsageData = true;
    recordUsage.screen("Map");
    recordUsage.feature("export");

    const names = calls.map((c) => c.name);
    expect(names).toEqual(["comapeo.usage.screen", "comapeo.usage.feature"]);
    expect(calls[0].screen).toBe("Map");
    expect(calls[1].feature).toBe("export");
    expect(Sentry.addBreadcrumb).toHaveBeenCalledTimes(2);
  });

  test("rpcStatusFor maps outcomes to bounded status tags", () => {
    const { rpcStatusFor } = require("../sentry-metrics");
    expect(rpcStatusFor(null)).toBe("ok");
    expect(rpcStatusFor(Object.assign(new Error("x"), { name: "TimeoutError" }))).toBe(
      "timeout",
    );
    expect(rpcStatusFor(new Error("boom"))).toBe("error");
  });
});
