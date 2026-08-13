/**
 * Transport-drop recovery wiring: a native `transportStateChange` drop must
 * reject in-flight RPC calls via the @comapeo/ipc transport-reset helpers,
 * and `subscribeToBackendRestart` must fire once the backend reaches STARTED
 * again after a drop (and only then).
 */

function setup() {
  const nativeListeners = {};
  const notifyCoreClientTransportReset = jest.fn();
  const notifyServicesClientTransportReset = jest.fn();
  const coreClient = { tag: "core" };
  const servicesClient = { tag: "services" };

  jest.resetModules();

  jest.doMock("expo", () => {
    class NativeModule {}
    class EventEmitter {
      addListener() {}
      removeListener() {}
      emit() {}
    }
    return {
      NativeModule,
      EventEmitter,
      requireNativeModule: () => ({
        sentryConfig: {},
        sentryPreferencesAtLaunch: {
          diagnosticsEnabled: true,
          applicationUsageData: false,
          debug: false,
        },
        postMessage: jest.fn(),
        addListener: (name, fn) => {
          (nativeListeners[name] ??= []).push(fn);
        },
        removeListener: jest.fn(),
      }),
    };
  });

  jest.doMock("@comapeo/ipc/client.js", () => ({
    createComapeoCoreClient: () => coreClient,
    createComapeoServicesClient: () => servicesClient,
    notifyCoreClientTransportReset,
    notifyServicesClientTransportReset,
  }));

  jest.doMock("@comapeo/ipc/errors.js", () => ({
    TransportClosedError: class TransportClosedError extends Error {},
  }));

  jest.doMock("@sentry/react-native", () => ({
    isInitialized: () => false,
    getActiveSpan: () => null,
    startSpan: jest.fn(),
    captureException: jest.fn(),
  }));

  jest.doMock("@sentry/core", () => ({
    getTraceData: () => ({}),
    startNewTrace: (cb) => cb(),
  }));

  jest.doMock("../sentry-metrics", () => ({
    rpcClientMetric: jest.fn(),
    rpcStatusFor: jest.fn(),
  }));

  const module = require("../ComapeoCoreModule");
  const emitNative = (name, payload) => {
    for (const fn of nativeListeners[name] ?? []) fn(payload);
  };
  return {
    module,
    emitNative,
    notifyCoreClientTransportReset,
    notifyServicesClientTransportReset,
    coreClient,
    servicesClient,
  };
}

describe("transport-drop recovery", () => {
  test("a transport drop resets both RPC clients", () => {
    const {
      emitNative,
      notifyCoreClientTransportReset,
      notifyServicesClientTransportReset,
      coreClient,
      servicesClient,
    } = setup();

    emitNative("transportStateChange", { state: "disconnected" });

    expect(notifyCoreClientTransportReset).toHaveBeenCalledTimes(1);
    expect(notifyCoreClientTransportReset).toHaveBeenCalledWith(coreClient);
    expect(notifyServicesClientTransportReset).toHaveBeenCalledTimes(1);
    expect(notifyServicesClientTransportReset).toHaveBeenCalledWith(
      servicesClient,
    );
  });

  test("a transport error also resets; a reconnect does not", () => {
    const { emitNative, notifyCoreClientTransportReset } = setup();

    emitNative("transportStateChange", { state: "connected" });
    expect(notifyCoreClientTransportReset).not.toHaveBeenCalled();

    emitNative("transportStateChange", { state: "error" });
    expect(notifyCoreClientTransportReset).toHaveBeenCalledTimes(1);
  });

  test("restart fires on STARTED after a drop, once per drop", () => {
    const { module, emitNative } = setup();
    const listener = jest.fn();
    module.subscribeToBackendRestart(listener);

    // STARTED without a preceding drop (normal boot) is not a restart.
    emitNative("stateChange", { state: "STARTED" });
    expect(listener).not.toHaveBeenCalled();

    emitNative("transportStateChange", { state: "disconnected" });
    expect(listener).not.toHaveBeenCalled();

    emitNative("stateChange", { state: "STARTING" });
    emitNative("stateChange", { state: "STARTED" });
    expect(listener).toHaveBeenCalledTimes(1);

    // No second firing until another drop happens.
    emitNative("stateChange", { state: "STARTED" });
    expect(listener).toHaveBeenCalledTimes(1);

    emitNative("transportStateChange", { state: "disconnected" });
    emitNative("stateChange", { state: "STARTED" });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  test("unsubscribe stops restart notifications", () => {
    const { module, emitNative } = setup();
    const listener = jest.fn();
    const unsubscribe = module.subscribeToBackendRestart(listener);
    unsubscribe();

    emitNative("transportStateChange", { state: "disconnected" });
    emitNative("stateChange", { state: "STARTED" });
    expect(listener).not.toHaveBeenCalled();
  });
});
