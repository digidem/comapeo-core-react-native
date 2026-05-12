/**
 * Unit tests for `initSentry()`. Stubs `@sentry/react-native` and the
 * native module so we can assert on the locked-option merge and the
 * branch decisions (skip-when-off, throw-on-host-init, fall-through-
 * when-no-dsn) without standing up a real RN harness.
 *
 * `jest.resetModules()` in `beforeEach` plus per-test `jest.doMock`
 * gives every test a fresh module-level `initialized` flag — the
 * sub-export's "called twice" guard would otherwise leak between
 * tests.
 *
 * Plain JS (not TS) because expo-module-scripts' jest preset's
 * babel-jest pipeline doesn't pick up the TypeScript preset for
 * files under `src/__tests__/`, and the type annotations are
 * decorative here — the test logic stands on its own.
 */

describe("initSentry", () => {
  let preferences;
  let configDsn;
  let isInitializedFlag;
  let initSpy;
  let setTagSpy;
  let setContextSpy;
  let addEventProcessorSpy;

  beforeEach(() => {
    preferences = { diagnosticsEnabled: true, captureApplicationData: false };
    configDsn = "https://x@sentry.io/1";
    isInitializedFlag = false;
    initSpy = jest.fn();
    setTagSpy = jest.fn();
    setContextSpy = jest.fn();
    addEventProcessorSpy = jest.fn();

    jest.resetModules();

    jest.doMock("../ComapeoCoreModule", () => ({
      state: { addListener: jest.fn() },
      readSentryConfig: () => ({
        dsn: configDsn,
        environment: "test",
        release: "1.0+1",
        // Stand-in plugin-supplied trace rate. The `0.5` is deliberately
        // not the SDK default 0.1 so a regression that bypasses the
        // plugin value and falls back to 0.1 would fail this test.
        tracesSampleRate: 0.5,
        enableLogs: true,
      }),
      readSentryPreferences: () => preferences,
      setDiagnosticsEnabledNative: jest.fn(),
      setCaptureApplicationDataNative: jest.fn(),
    }));

    const globalScope = {
      setTag: setTagSpy,
      setContext: setContextSpy,
      addEventProcessor: addEventProcessorSpy,
    };

    jest.doMock("@sentry/react-native", () => ({
      init: initSpy,
      isInitialized: () => isInitializedFlag,
      getGlobalScope: () => globalScope,
      captureException: jest.fn(),
      captureMessage: jest.fn(),
      addBreadcrumb: jest.fn(),
      setTag: jest.fn(),
      startSpan: jest.fn(),
      getActiveSpan: jest.fn(),
      continueTrace: jest.fn(),
      logger: {
        trace: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        fatal: jest.fn(),
      },
    }));

    jest.doMock("@sentry/core", () => ({
      getTraceData: jest.fn(() => ({})),
    }));
  });

  test("skips Sentry.init when diagnosticsEnabled is false", () => {
    preferences.diagnosticsEnabled = false;
    const { initSentry } = require("../sentry");
    initSentry();
    expect(initSpy).not.toHaveBeenCalled();
    // Scope writes should also not have run — the adapter never got
    // registered, and the scope writes are gated on that.
    expect(setTagSpy).not.toHaveBeenCalled();
  });

  test("skips Sentry.init when DSN absent (plugin not registered)", () => {
    configDsn = undefined;
    const { initSentry } = require("../sentry");
    initSentry(); // must not throw
    expect(initSpy).not.toHaveBeenCalled();
  });

  test("calls Sentry.init with locked options when diagnostics on and DSN present", () => {
    const { initSentry } = require("../sentry");
    initSentry();
    expect(initSpy).toHaveBeenCalledTimes(1);
    const opts = initSpy.mock.calls[0][0];
    expect(opts.dsn).toBe("https://x@sentry.io/1");
    expect(opts.environment).toBe("test");
    expect(opts.release).toBe("1.0+1");
    expect(opts.sendDefaultPii).toBe(false);
    // captureApplicationData=false → traces forced to 0 regardless
    // of the plugin's configured 0.5.
    expect(opts.tracesSampleRate).toBe(0);
    expect(opts.enableLogs).toBe(true);
  });

  test("tracesSampleRate uses plugin value when captureApplicationData is on", () => {
    preferences.captureApplicationData = true;
    const { initSentry } = require("../sentry");
    initSentry();
    expect(initSpy.mock.calls[0][0].tracesSampleRate).toBe(0.5);
  });

  test("throws migration error when host called Sentry.init first", () => {
    isInitializedFlag = true;
    const { initSentry } = require("../sentry");
    expect(() => initSentry()).toThrow(/Sentry init/i);
    expect(() => initSentry()).toThrow(/initSentry/);
  });

  test("migration error fires again on retry (isInitialized check precedes flag flip)", () => {
    // Defensive: if a host catches the migration error and tries
    // again (e.g. after clearing whatever wrongly init'd Sentry),
    // they should still see the actionable migration message, not
    // the less-helpful "called twice" message.
    isInitializedFlag = true;
    const { initSentry } = require("../sentry");
    expect(() => initSentry()).toThrow(/initSentry/);
    expect(() => initSentry()).toThrow(/initSentry/);
  });

  test("throws on a normal duplicate init (host called initSentry twice)", () => {
    const { initSentry } = require("../sentry");
    initSentry();
    expect(() => initSentry()).toThrow(/called twice/);
  });

  test("host integrations function is applied to the SDK defaults", () => {
    const { initSentry } = require("../sentry");
    const hostIntegration = { name: "Host" };
    initSentry({
      integrations: (defaults) => [...defaults, hostIntegration],
    });
    const integrationsFn = initSpy.mock.calls[0][0].integrations;
    expect(typeof integrationsFn).toBe("function");
    const result = integrationsFn([{ name: "A" }, { name: "B" }]);
    expect(result).toEqual([{ name: "A" }, { name: "B" }, hostIntegration]);
  });

  test("integrations function pass-through when host doesn't extend", () => {
    const { initSentry } = require("../sentry");
    initSentry();
    const integrationsFn = initSpy.mock.calls[0][0].integrations;
    const defaults = [{ name: "A" }];
    expect(integrationsFn(defaults)).toBe(defaults);
  });

  test("beforeSend chains: our scrubber runs first, host's second", () => {
    // Our scrubber is currently identity (PII implementation lands
    // in Phase 9b) — but the chain order itself is load-bearing:
    // the host's hook must see only post-scrub payloads, never raw
    // ones. Test by passing a host hook that observes the input.
    const hostBeforeSend = jest.fn((event) => ({
      ...event,
      hostMarker: true,
    }));
    const { initSentry } = require("../sentry");
    initSentry({ beforeSend: hostBeforeSend });
    const chain = initSpy.mock.calls[0][0].beforeSend;
    const result = chain({ original: true }, undefined);
    expect(hostBeforeSend).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ original: true, hostMarker: true });
  });

  test("beforeSend drops the event when host returns null", () => {
    const hostBeforeSend = jest.fn(() => null);
    const { initSentry } = require("../sentry");
    initSentry({ beforeSend: hostBeforeSend });
    const chain = initSpy.mock.calls[0][0].beforeSend;
    expect(chain({ original: true }, undefined)).toBeNull();
  });

  test("scope-default tags are written after init", () => {
    const { initSentry } = require("../sentry");
    initSentry();
    // Three load-bearing scope tags: proc, layer, comapeo.rn. Plus
    // `comapeoBackend` context and an event processor for
    // `event.modules`. Test by name to keep the assertion stable
    // across module-version label changes.
    const tagKeys = setTagSpy.mock.calls.map((c) => c[0]);
    expect(tagKeys).toEqual(
      expect.arrayContaining(["proc", "layer", "comapeo.rn"]),
    );
    expect(setContextSpy).toHaveBeenCalledWith(
      "comapeoBackend",
      expect.any(Object),
    );
    expect(addEventProcessorSpy).toHaveBeenCalled();
  });

  test("host tags are merged onto the global scope", () => {
    const { initSentry } = require("../sentry");
    initSentry({ tags: { app: "comapeo-mobile", env: "staging" } });
    const tagCalls = setTagSpy.mock.calls;
    expect(tagCalls).toEqual(
      expect.arrayContaining([
        ["app", "comapeo-mobile"],
        ["env", "staging"],
      ]),
    );
  });
});
