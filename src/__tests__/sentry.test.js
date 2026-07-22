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

// Dependency-free constants module, safe to require before the per-test
// mocks are registered (it pulls in no RN / native code).
const { SENTRY_OWNED_GLOBAL_KEY } = require("../sentry-tags");

describe("initSentry", () => {
  let preferences;
  let livePreferences;
  let configDsn;
  let configUserId;
  let isInitializedFlag;
  let initSpy;
  let setUserSpy;
  let setTagSpy;
  let setContextSpy;
  let addEventProcessorSpy;
  let setDiagnosticsEnabledNativeSpy;
  let addBreadcrumbSpy;
  let appStateHandler;

  beforeEach(() => {
    preferences = {
      diagnosticsEnabled: true,
      applicationUsageData: false,
      debug: false,
    };
    // The live view starts equal to the boot snapshot; tests mutate it to
    // simulate a `setX` made after launch.
    livePreferences = { ...preferences };
    configDsn = "https://x@sentry.io/1";
    configUserId = undefined;
    isInitializedFlag = false;
    initSpy = jest.fn();
    setUserSpy = jest.fn();
    setTagSpy = jest.fn();
    setContextSpy = jest.fn();
    addEventProcessorSpy = jest.fn();
    setDiagnosticsEnabledNativeSpy = jest.fn(() => Promise.resolve());
    addBreadcrumbSpy = jest.fn();
    appStateHandler = undefined;

    jest.resetModules();

    // `initSentry` records ownership on a `globalThis` marker so a
    // post-reload re-entry (module state gone, SDK alive) stays
    // idempotent. `jest.resetModules()` doesn't touch globals, so clear
    // it here to keep each test isolated.
    delete globalThis[SENTRY_OWNED_GLOBAL_KEY];

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
        ...(configUserId ? { userId: configUserId } : {}),
      }),
      readSentryPreferencesAtLaunch: () => preferences,
      readCurrentSentryPreferences: () => livePreferences,
      readRootUserIdNative: () => "AB3D-EF9H-J2K3",
      setDiagnosticsEnabledNative: setDiagnosticsEnabledNativeSpy,
      setApplicationUsageDataNative: jest.fn(() => Promise.resolve()),
      setDebugEnabledNative: jest.fn(() => Promise.resolve()),
    }));

    // Stub the metrics layer so this unit test doesn't pull it in (and
    // the circular import back to `./sentry`).
    jest.doMock("../sentry-metrics", () => ({
      rpcClientMetric: jest.fn(),
      rpcStatusFor: jest.fn(() => "ok"),
    }));

    const globalScope = {
      setTag: setTagSpy,
      setContext: setContextSpy,
      addEventProcessor: addEventProcessorSpy,
    };

    jest.doMock("@sentry/react-native", () => ({
      init: initSpy,
      isInitialized: () => isInitializedFlag,
      setUser: setUserSpy,
      getGlobalScope: () => globalScope,
      captureException: jest.fn(),
      captureMessage: jest.fn(),
      addBreadcrumb: addBreadcrumbSpy,
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

    // `react-native` is needed because `src/sentry.ts` reads
    // `Platform.OS` and attaches an `AppState` listener at module
    // load. Without the mock, Jest tries to load the real RN bundle
    // and trips on its ESM-style imports under the expo-module-scripts
    // preset. Capture the AppState handler so tests can drive
    // background/foreground transitions.
    jest.doMock("react-native", () => ({
      Platform: { OS: "ios" },
      AppState: {
        addEventListener: (event, handler) => {
          if (event === "change") appStateHandler = handler;
        },
      },
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
    // debug=false → the plugin-configured rate (0.5) applies. Native folds the
    // debug window into the backend's rate; RN applies the same formula.
    expect(opts.tracesSampleRate).toBe(0.5);
    expect(opts.enableLogs).toBe(true);
  });

  test("applies the native-derived user.id via Sentry.setUser", () => {
    configUserId = "e15e7255ae360358";
    const { initSentry } = require("../sentry");
    initSentry();
    expect(setUserSpy).toHaveBeenCalledWith({ id: "e15e7255ae360358" });
  });

  test("skips Sentry.setUser when native provided no userId", () => {
    const { initSentry } = require("../sentry");
    initSentry();
    expect(setUserSpy).not.toHaveBeenCalled();
  });

  test("getRootUserId returns the native root ID (never sent to Sentry)", () => {
    const { getRootUserId } = require("../sentry");
    expect(getRootUserId()).toBe("AB3D-EF9H-J2K3");
  });

  test("tracesSampleRate is 1.0 when debug is on, else the configured rate", () => {
    preferences.debug = true;
    const { initSentry } = require("../sentry");
    initSentry();
    expect(initSpy.mock.calls[0][0].tracesSampleRate).toBe(1.0);
  });

  test("applicationUsageData does NOT drive tracesSampleRate (debug + config do)", () => {
    preferences.applicationUsageData = true;
    preferences.debug = false;
    const { initSentry } = require("../sentry");
    initSentry();
    // Usage tier is irrelevant to tracing; the non-debug rate is the config (0.5).
    expect(initSpy.mock.calls[0][0].tracesSampleRate).toBe(0.5);
  });

  test("autoInitializeNativeSdk=false on iOS so AppLifecycleDelegate's native init isn't replaced", () => {
    // Default mock is iOS.
    const { initSentry } = require("../sentry");
    initSentry();
    expect(initSpy.mock.calls[0][0].autoInitializeNativeSdk).toBe(false);
  });

  test("autoInitializeNativeSdk omitted on Android so RNSentry inits the main-process SDK", () => {
    jest.doMock("react-native", () => ({
      Platform: { OS: "android" },
      AppState: { addEventListener: jest.fn() },
    }));
    const { initSentry } = require("../sentry");
    initSentry();
    const opts = initSpy.mock.calls[0][0];
    expect("autoInitializeNativeSdk" in opts).toBe(false);
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

  test("is idempotent on a duplicate init in the same context (no throw, no re-init)", () => {
    const { initSentry } = require("../sentry");
    initSentry();
    expect(initSpy).toHaveBeenCalledTimes(1);
    expect(() => initSentry()).not.toThrow();
    // The live client must not be replaced.
    expect(initSpy).toHaveBeenCalledTimes(1);
  });

  test("is idempotent across a JS-bundle reload (SDK + global marker survive, module state reset)", () => {
    const first = require("../sentry");
    first.initSentry();
    expect(initSpy).toHaveBeenCalledTimes(1);

    // Reload: the SDK and our globalThis marker outlive the bundle, but
    // our module-level state (`initialized`, `sentryReady`) is torn down
    // and rebuilt. The re-entry must NOT re-init or hit the migration
    // throw — it's our own prior init, not a host `Sentry.init`.
    isInitializedFlag = true;
    jest.resetModules();
    const second = require("../sentry");
    expect(() => second.initSentry()).not.toThrow();
    expect(initSpy).toHaveBeenCalledTimes(1);
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
    // The host's hook must see only post-scrub payloads, never raw
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

  test("beforeSend scrubber redacts lat/lng and rootKey markers before the host sees them", () => {
    const seen = [];
    const hostBeforeSend = jest.fn((event) => {
      seen.push(JSON.stringify(event));
      return event;
    });
    const { initSentry } = require("../sentry");
    initSentry({ beforeSend: hostBeforeSend });
    const chain = initSpy.mock.calls[0][0].beforeSend;
    chain(
      {
        message: "latitude: -12.34",
        exception: {
          values: [{ type: "Error", value: "rootKey=aGVsbG8td29ybGQtMTIzNA" }],
        },
        extra: { token: "bm90LWEtcmVhbC1rZXktMQ" },
      },
      undefined,
    );
    const payload = seen[0];
    expect(payload).toContain("[redacted]");
    expect(payload).not.toContain("aGVsbG8td29ybGQtMTIzNA"); // rootKey value gone
    expect(payload).not.toContain("-12.34"); // lat/lng gone
    // Deliberately no value-shape rule for bare tokens (the key only ever
    // travels next to its field name — see the SCRUB_PATTERNS note in
    // sentry-scrub.ts), so a bare token in `extra` survives.
    expect(payload).toContain("bm90LWEtcmVhbC1rZXktMQ");
  });

  test("beforeBreadcrumb reduces HTTP URLs to host-only", () => {
    const { initSentry } = require("../sentry");
    initSentry();
    const beforeBreadcrumb = initSpy.mock.calls[0][0].beforeBreadcrumb;
    const result = beforeBreadcrumb(
      {
        category: "http",
        data: { url: "https://cloud.comapeo.app/projects/abc?token=x" },
      },
      undefined,
    );
    expect(result.data.url).toBe("https://cloud.comapeo.app");
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

  test("toggle getters read the live value, not the boot snapshot", () => {
    const {
      getDiagnosticsEnabled,
      getApplicationUsageData,
      getDebugEnabled,
    } = require("../sentry");
    // Simulate a setX made after launch: the live view diverges from the
    // boot snapshot. The getters must reflect the live view so a settings
    // screen reads back the user's just-made choice.
    livePreferences.diagnosticsEnabled = false;
    livePreferences.applicationUsageData = true;
    livePreferences.debug = true;
    expect(getDiagnosticsEnabled()).toBe(false);
    expect(getApplicationUsageData()).toBe(true);
    expect(getDebugEnabled()).toBe(true);
    // The boot snapshot (what governs this session) is untouched.
    expect(preferences.diagnosticsEnabled).toBe(true);
  });

  test("setter updates the live view only after the native write resolves", async () => {
    const { setDiagnosticsEnabled, getDiagnosticsEnabled } =
      require("../sentry");
    let resolveNative;
    setDiagnosticsEnabledNativeSpy.mockImplementation(
      () => new Promise((r) => { resolveNative = r; }),
    );
    const pending = setDiagnosticsEnabled(false);
    // Not yet persisted — the getter must still show the old value.
    expect(getDiagnosticsEnabled()).toBe(true);
    resolveNative();
    await pending;
    expect(getDiagnosticsEnabled()).toBe(false);
  });

  test("setter leaves the live view unchanged when the native write rejects", async () => {
    const { setDiagnosticsEnabled, getDiagnosticsEnabled } =
      require("../sentry");
    setDiagnosticsEnabledNativeSpy.mockImplementation(() =>
      Promise.reject(new Error("native context not attached")),
    );
    await expect(setDiagnosticsEnabled(false)).rejects.toThrow(
      "native context not attached",
    );
    // The failed opt-out must not be reported as done — the on-disk
    // value is still true, so the getter must agree.
    expect(getDiagnosticsEnabled()).toBe(true);
  });

  test("usage tier on: bg/fg AppState changes add comapeo.app.* breadcrumbs", () => {
    preferences.applicationUsageData = true;
    const { initSentry } = require("../sentry");
    initSentry();
    expect(typeof appStateHandler).toBe("function");

    appStateHandler("background");
    appStateHandler("active");
    expect(addBreadcrumbSpy.mock.calls.map(([c]) => c.message)).toEqual([
      "comapeo.app.background",
      "comapeo.app.foreground",
    ]);
    expect(addBreadcrumbSpy.mock.calls[0][0].category).toBe(
      "comapeo.app.lifecycle",
    );

    // Repeated same-direction events (Android can fire "active" more
    // than once) and iOS transient "inactive" add nothing.
    appStateHandler("active");
    appStateHandler("inactive");
    expect(addBreadcrumbSpy).toHaveBeenCalledTimes(2);
  });

  test("usage tier off: AppState changes add no breadcrumbs", () => {
    preferences.applicationUsageData = false;
    const { initSentry } = require("../sentry");
    initSentry();
    appStateHandler("background");
    appStateHandler("active");
    expect(addBreadcrumbSpy).not.toHaveBeenCalled();
  });

  test("no breadcrumbs when diagnostics is off (Sentry never initialised)", () => {
    preferences.diagnosticsEnabled = false;
    preferences.applicationUsageData = true;
    const { initSentry } = require("../sentry");
    initSentry();
    appStateHandler("background");
    expect(addBreadcrumbSpy).not.toHaveBeenCalled();
  });
});
