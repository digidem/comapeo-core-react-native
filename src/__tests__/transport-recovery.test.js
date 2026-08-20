/**
 * Two-phase transport-drop recovery: at drop time @comapeo/ipc's
 * `notifyTransportReset` rejects in-flight calls (no resubscription — that
 * would nudge the native connect out of its terminal Error state in a loop);
 * once BOTH the transport is reconnected AND the lifecycle state is STARTED,
 * subscriptions are replayed via `resubscribe`. `subscribeToBackendRestart`
 * listeners fire only on a genuine backend restart, detected by the boot
 * nonce on the control channel's `ready` frame changing; without a nonce
 * (older backend/native) every recovery fires conservatively.
 */

function setup({ initialState = "STOPPED" } = {}) {
  const nativeListeners = {};
  const notifyTransportReset = jest.fn();
  const resubscribe = jest.fn();
  const coreClient = { tag: "core" };
  const servicesClient = { tag: "services" };
  let currentState = initialState;
  let currentNonce = null;

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
        getState: () => currentState,
        getBootNonce: () => currentNonce,
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
    notifyTransportReset,
    resubscribe,
  }));

  jest.doMock("@comapeo/ipc/errors.js", () => ({
    RpcChannelClosedError: class RpcChannelClosedError extends Error {},
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
  // The native stateChange event and getState()/getBootNonce() move
  // together in reality: Kotlin stores both before emitting.
  const setBackendState = (state, { bootNonce } = {}) => {
    currentState = state;
    if (bootNonce !== undefined) currentNonce = bootNonce;
    emitNative("stateChange", {
      state,
      ...(bootNonce !== undefined ? { bootNonce } : {}),
    });
  };
  return {
    module,
    emitNative,
    setBackendState,
    setStateSilently: (state) => {
      currentState = state;
    },
    notifyTransportReset,
    resubscribe,
    coreClient,
    servicesClient,
  };
}

describe("transport-drop recovery", () => {
  test("a drop resets both clients and does NOT resubscribe", () => {
    const s = setup({ initialState: "STARTED" });

    s.emitNative("transportStateChange", { state: "disconnected" });

    expect(s.notifyTransportReset).toHaveBeenCalledTimes(2);
    expect(s.notifyTransportReset).toHaveBeenCalledWith(s.coreClient);
    expect(s.notifyTransportReset).toHaveBeenCalledWith(s.servicesClient);
    expect(s.resubscribe).not.toHaveBeenCalled();
  });

  test("a transport error also resets; double reset is tolerated", () => {
    const s = setup({ initialState: "STARTED" });

    s.emitNative("transportStateChange", { state: "disconnected" });
    s.emitNative("transportStateChange", { state: "error" });

    expect(s.notifyTransportReset).toHaveBeenCalledTimes(4);
    expect(s.resubscribe).not.toHaveBeenCalled();
  });

  test("recovery needs BOTH transport connected and state STARTED (state last)", () => {
    const s = setup({ initialState: "STARTED" });
    const listener = jest.fn();
    s.module.subscribeToBackendRestart(listener);

    s.emitNative("transportStateChange", { state: "disconnected" });
    s.setStateSilently("ERROR");
    s.emitNative("transportStateChange", { state: "connected" });
    // Transport back but backend still booting: nothing yet.
    expect(s.resubscribe).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();

    s.setBackendState("STARTING");
    s.setBackendState("STARTED");
    expect(s.resubscribe).toHaveBeenCalledTimes(2);
    expect(s.resubscribe).toHaveBeenCalledWith(s.coreClient);
    expect(s.resubscribe).toHaveBeenCalledWith(s.servicesClient);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("recovery when transport reconnects last (message-socket-only drop; no nonce → conservative restart)", () => {
    // Control socket never left STARTED, so no stateChange event ever fires.
    // No boot nonce available, so the restart signal fires conservatively.
    const s = setup({ initialState: "STARTED" });
    const listener = jest.fn();
    s.module.subscribeToBackendRestart(listener);

    s.emitNative("transportStateChange", { state: "disconnected" });
    expect(listener).not.toHaveBeenCalled();

    s.emitNative("transportStateChange", { state: "connected" });
    expect(s.resubscribe).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("restart fires once per drop; STARTED without a drop fires nothing (no nonce)", () => {
    const s = setup({ initialState: "STOPPED" });
    const listener = jest.fn();
    s.module.subscribeToBackendRestart(listener);

    // Normal boot: connected + STARTED with no preceding drop.
    s.emitNative("transportStateChange", { state: "connected" });
    s.setBackendState("STARTING");
    s.setBackendState("STARTED");
    expect(listener).not.toHaveBeenCalled();

    s.emitNative("transportStateChange", { state: "disconnected" });
    s.emitNative("transportStateChange", { state: "connected" });
    expect(listener).toHaveBeenCalledTimes(1);

    // Repeat STARTED events without a new drop don't re-fire.
    s.setBackendState("STARTED");
    expect(listener).toHaveBeenCalledTimes(1);

    s.emitNative("transportStateChange", { state: "disconnected" });
    s.emitNative("transportStateChange", { state: "connected" });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  test("reconnect with the same boot nonce resubscribes but does NOT signal a restart", () => {
    const s = setup();
    const listener = jest.fn();
    s.module.subscribeToBackendRestart(listener);

    // Initial boot: connected, STARTED with nonce n1.
    s.emitNative("transportStateChange", { state: "connected" });
    s.setBackendState("STARTING");
    s.setBackendState("STARTED", { bootNonce: "n1" });
    expect(listener).not.toHaveBeenCalled();

    // App-side drop; the backend kept running, so the replayed `ready`
    // carries the same nonce.
    s.emitNative("transportStateChange", { state: "disconnected" });
    s.emitNative("transportStateChange", { state: "connected" });

    expect(s.resubscribe).toHaveBeenCalledWith(s.coreClient);
    expect(s.resubscribe).toHaveBeenCalledWith(s.servicesClient);
    expect(listener).not.toHaveBeenCalled();
  });

  test("reconnect with a NEW boot nonce resubscribes and then signals a restart", () => {
    const s = setup();
    const listener = jest.fn();
    s.module.subscribeToBackendRestart(listener);

    s.emitNative("transportStateChange", { state: "connected" });
    s.setBackendState("STARTING");
    s.setBackendState("STARTED", { bootNonce: "n1" });

    // Backend killed and restarted: transport drops, lifecycle flaps, and
    // the fresh process announces itself with a new nonce.
    s.emitNative("transportStateChange", { state: "disconnected" });
    s.setStateSilently("ERROR");
    s.emitNative("transportStateChange", { state: "connected" });
    expect(listener).not.toHaveBeenCalled();

    s.setBackendState("STARTING");
    s.setBackendState("STARTED", { bootNonce: "n2" });

    expect(s.resubscribe).toHaveBeenCalledWith(s.coreClient);
    expect(s.resubscribe).toHaveBeenCalledWith(s.servicesClient);
    expect(listener).toHaveBeenCalledTimes(1);
    // Subscriptions are replayed before the restart signal fires, so a
    // listener's re-fetch runs against a fully re-wired client.
    const firstResubscribe = Math.min(...s.resubscribe.mock.invocationCallOrder);
    expect(firstResubscribe).toBeLessThan(listener.mock.invocationCallOrder[0]);

    // A later app-side reconnect to the SAME restarted backend stays silent.
    s.emitNative("transportStateChange", { state: "disconnected" });
    s.emitNative("transportStateChange", { state: "connected" });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("a drop before the first-ever nonce does not signal a restart", () => {
    // Transport dropped mid-boot: recovery completes at the FIRST `ready`
    // this client has ever seen — initial-boot completion, not a restart.
    const s = setup();
    const listener = jest.fn();
    s.module.subscribeToBackendRestart(listener);

    s.emitNative("transportStateChange", { state: "connected" });
    s.setBackendState("STARTING");
    s.emitNative("transportStateChange", { state: "disconnected" });
    s.emitNative("transportStateChange", { state: "connected" });
    s.setBackendState("STARTED", { bootNonce: "n1" });

    expect(s.resubscribe).toHaveBeenCalledWith(s.coreClient);
    expect(listener).not.toHaveBeenCalled();

    // But the nonce WAS recorded: a real restart afterwards fires.
    s.emitNative("transportStateChange", { state: "disconnected" });
    s.setStateSilently("STARTING");
    s.emitNative("transportStateChange", { state: "connected" });
    s.setBackendState("STARTED", { bootNonce: "n2" });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("a throwing restart listener does not block the others", () => {
    const s = setup({ initialState: "STARTED" });
    const bad = jest.fn(() => {
      throw new Error("listener boom");
    });
    const good = jest.fn();
    s.module.subscribeToBackendRestart(bad);
    s.module.subscribeToBackendRestart(good);

    s.emitNative("transportStateChange", { state: "disconnected" });
    s.emitNative("transportStateChange", { state: "connected" });

    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
  });

  test("unsubscribe stops restart notifications", () => {
    const s = setup({ initialState: "STARTED" });
    const listener = jest.fn();
    const unsubscribe = s.module.subscribeToBackendRestart(listener);
    unsubscribe();

    s.emitNative("transportStateChange", { state: "disconnected" });
    s.emitNative("transportStateChange", { state: "connected" });
    expect(listener).not.toHaveBeenCalled();
  });
});
