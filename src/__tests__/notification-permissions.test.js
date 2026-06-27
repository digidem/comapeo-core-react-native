/**
 * Unit tests for the notification-permission wrappers exported from
 * `src/ComapeoCoreModule.ts`. The native methods are exercised on a
 * device (the system dialog can't run under jest); here we cover the
 * JS contract:
 *   - calls delegate to the native module and pass its response through,
 *   - the no-op fallback resolves `granted` when the native method is
 *     absent (test / pre-API-33 / iOS shapes where the host never branches).
 *
 * `requireNativeModule` is stubbed so the module loads without a JSI
 * runtime. `@sentry/*` and `react-native` are stubbed because importing
 * `ComapeoCoreModule` pulls the RPC-tracing machinery in transitively.
 *
 * Plain JS (not TS) for the same reason as `sentry.test.js`: the
 * expo-module-scripts jest preset's babel pipeline doesn't apply the
 * TypeScript preset to files under `src/__tests__/`.
 */

describe("notification permission wrappers", () => {
  let nativeModule;

  function loadModule() {
    jest.resetModules();

    jest.doMock("expo", () => ({
      NativeModule: class {},
      EventEmitter: class {},
      requireNativeModule: () => nativeModule,
    }));

    // `ComapeoCoreModule` constructs the RPC client + Sentry tracing hook
    // at import time. Stub the deps so the import doesn't reach a real
    // RN/Sentry runtime.
    jest.doMock("@comapeo/ipc/client.js", () => ({
      createComapeoCoreClient: () => ({}),
      createComapeoServicesClient: () => ({}),
    }));
    jest.doMock("@sentry/react-native", () => ({
      getActiveSpan: jest.fn(),
      getRootSpan: jest.fn(),
      spanToJSON: jest.fn(() => ({})),
      startSpan: jest.fn(),
      isInitialized: () => false,
      captureException: jest.fn(),
    }));
    jest.doMock("@sentry/core", () => ({
      getTraceData: jest.fn(() => ({})),
      startNewTrace: jest.fn(),
    }));

    return require("../ComapeoCoreModule");
  }

  test("getNotificationPermissionsAsync delegates to the native module", async () => {
    const response = {
      status: "denied",
      granted: false,
      canAskAgain: false,
      expires: "never",
    };
    nativeModule = {
      getNotificationPermissionsAsync: jest.fn().mockResolvedValue(response),
    };

    const { getNotificationPermissionsAsync } = loadModule();
    await expect(getNotificationPermissionsAsync()).resolves.toEqual(response);
    expect(nativeModule.getNotificationPermissionsAsync).toHaveBeenCalledTimes(1);
  });

  test("requestNotificationPermissionsAsync delegates to the native module", async () => {
    const response = {
      status: "granted",
      granted: true,
      canAskAgain: true,
      expires: "never",
    };
    nativeModule = {
      requestNotificationPermissionsAsync: jest.fn().mockResolvedValue(response),
    };

    const { requestNotificationPermissionsAsync } = loadModule();
    await expect(requestNotificationPermissionsAsync()).resolves.toEqual(response);
    expect(nativeModule.requestNotificationPermissionsAsync).toHaveBeenCalledTimes(
      1,
    );
  });

  test("getNotificationPermissionsAsync falls back to granted when native method absent", async () => {
    nativeModule = {};
    const { getNotificationPermissionsAsync } = loadModule();
    await expect(getNotificationPermissionsAsync()).resolves.toEqual({
      status: "granted",
      granted: true,
      canAskAgain: true,
      expires: "never",
    });
  });

  test("requestNotificationPermissionsAsync falls back to granted when native method absent", async () => {
    nativeModule = {};
    const { requestNotificationPermissionsAsync } = loadModule();
    await expect(requestNotificationPermissionsAsync()).resolves.toEqual({
      status: "granted",
      granted: true,
      canAskAgain: true,
      expires: "never",
    });
  });
});
