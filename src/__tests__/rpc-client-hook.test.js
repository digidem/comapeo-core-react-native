/**
 * RN-side onRequestHook split (§11.9), mirroring backend's
 * `sentry.test.mjs` debug-on/debug-off cases. The metric is recorded on
 * EVERY call; the per-RPC span only runs under `diagnosticsEnabled &&
 * debug` with Sentry initialised.
 *
 * `debugTracingEnabled` and the `createComapeoCoreClient` call are both
 * evaluated at module construction, so each case uses `jest.resetModules`
 * + per-case `jest.doMock` to capture a fresh hook.
 */

function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

function setup({ debug, diagnosticsEnabled = true, sentryInitialized = true }) {
  let capturedHook;
  const startSpan = jest.fn((_opts, cb) =>
    cb({ setAttribute: jest.fn(), setStatus: jest.fn() }),
  );
  const rpcClientMetric = jest.fn();
  const rpcClientSendMetric = jest.fn();
  const rpcStatusFor = jest.fn((error) => (error ? "error" : "ok"));

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
        sentryPreferences: { diagnosticsEnabled, applicationUsageData: false, debug },
        postMessage: jest.fn(),
        addListener: jest.fn(),
        removeListener: jest.fn(),
      }),
    };
  });

  jest.doMock("@comapeo/ipc/client.js", () => ({
    createComapeoCoreClient: (_port, opts) => {
      capturedHook = opts.onRequestHook;
      return {};
    },
    createComapeoServicesClient: () => ({}),
  }));

  jest.doMock("@sentry/react-native", () => ({
    isInitialized: () => sentryInitialized,
    getActiveSpan: () => null,
    startSpan,
    captureException: jest.fn(),
  }));

  jest.doMock("@sentry/core", () => ({
    getTraceData: () => ({}),
    startNewTrace: (cb) => cb(),
  }));

  jest.doMock("../sentry-metrics", () => ({
    rpcClientMetric,
    rpcClientSendMetric,
    rpcStatusFor,
  }));

  require("../ComapeoCoreModule");
  return { capturedHook: () => capturedHook, startSpan, rpcClientMetric, rpcStatusFor };
}

describe("onRequestHook", () => {
  test("debug=false: records the metric, never starts a span", async () => {
    const { capturedHook, startSpan, rpcClientMetric } = setup({ debug: false });
    const next = jest.fn(() => Promise.resolve("response"));
    capturedHook()({ method: ["someMethod"] }, next);
    await flushMicrotasks();

    expect(next).toHaveBeenCalledTimes(1);
    expect(startSpan).not.toHaveBeenCalled();
    expect(rpcClientMetric).toHaveBeenCalledTimes(1);
    expect(rpcClientMetric.mock.calls[0][0]).toBe("someMethod");
    expect(rpcClientMetric.mock.calls[0][1]).toBe("ok");
  });

  test("debug=true + Sentry up: starts a span AND records the metric", async () => {
    const { capturedHook, startSpan, rpcClientMetric } = setup({ debug: true });
    const next = jest.fn(() => Promise.resolve("response"));
    capturedHook()({ method: ["someMethod"] }, next);
    await flushMicrotasks();

    expect(startSpan).toHaveBeenCalledTimes(1);
    expect(rpcClientMetric).toHaveBeenCalledTimes(1);
    expect(rpcClientMetric.mock.calls[0][0]).toBe("someMethod");
  });

  test("error path passes rpcStatusFor(error) through to the metric", async () => {
    const { capturedHook, rpcClientMetric, rpcStatusFor } = setup({ debug: false });
    const err = new Error("boom");
    const next = jest.fn(() => Promise.reject(err));
    capturedHook()({ method: ["someMethod"] }, next);
    await flushMicrotasks();

    expect(rpcStatusFor).toHaveBeenCalledWith(err);
    expect(rpcClientMetric.mock.calls[0][1]).toBe("error");
  });
});
