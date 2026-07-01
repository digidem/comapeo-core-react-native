import { test } from "node:test";
import assert from "node:assert/strict";

import * as Sentry from "@sentry/node-core";

import { initSentry } from "./sentry-init.js";
import { rpcHook, setSink, flush } from "./sentry.js";
import * as metrics from "./metrics.js";

/**
 * debug-on / debug-off branching of `rpcHook`:
 *   - debug OFF ⇒ no span (no envelope reaches the sink), but the metric
 *                 IS recorded.
 *   - debug ON  ⇒ span created (envelope reaches the sink) AND metric
 *                 recorded while the span is active.
 *
 * `sentry.js`'s `init` wires the metrics layer with the real SDK; we
 * immediately re-`init` the metrics layer with a fake recorder SDK so a
 * metric emission records into an array instead of producing its own
 * envelope. That keeps the sink-frame count attributable to spans only.
 *
 * Presence-not-shape on the span side: assert "an envelope reached the
 * sink", never on op-name strings.
 */

const baseArgv = {
  sentryDsn: "https://x@sentry.io/1",
  sentryEnvironment: "test",
  sentryRelease: "0.0.0+test",
  sentrySampleRate: "1.0",
  sentryTracesSampleRate: "1.0",
  sentryRpcArgsBytes: "0",
  sentryEnableLogs: false,
  sentryBaggage: "",
  applicationUsageData: true,
  deviceClass: "mid",
  osMajor: "android.14",
  platformTag: "android",
};

/** Fake metrics SDK that records distribution calls instead of emitting. */
function recordingMetricsSdk() {
  const distributions = [];
  return {
    distributions,
    sdk: {
      metrics: {
        distribution: (name, value, data) =>
          distributions.push({ name, value, ...data }),
        count: () => {},
        gauge: () => {},
      },
    },
  };
}

/** Drive one RPC through the hook; resolves once `next()` has been called. */
async function driveHook(hook) {
  let nextCalled = false;
  await new Promise((resolve) => {
    hook(
      {
        method: ["read", "doc"],
        args: [],
        metadata: {
          "sentry-trace":
            "12345678901234567890123456789012-1234567890123456-1",
          baggage: "",
        },
      },
      async () => {
        nextCalled = true;
        setImmediate(resolve);
      },
    );
  });
  return nextCalled;
}

test("debug ON: rpcHook produces an envelope AND records the rpc metric", async () => {
  initSentry({ ...baseArgv, debug: true });
  const rec = recordingMetricsSdk();
  metrics.init({
    Sentry: rec.sdk,
    platform: "android",
    deviceClass: "mid",
    osMajor: "android.14",
    applicationUsageData: true,
  });

  const captured = [];
  setSink((frame) => captured.push(frame));

  const hook = rpcHook();
  assert.ok(hook, "rpcHook returned undefined — Sentry didn't initialise");

  const nextCalled = await driveHook(hook);
  await flush(2000);

  assert.ok(nextCalled, "rpcHook did not invoke next()");
  assert.ok(
    captured.length > 0,
    "no envelope frame reached the sink — debug span not created",
  );
  assert.ok(
    rec.distributions.some(
      (d) => d.name === "comapeo.rpc.server.duration_ms",
    ),
    "rpc.server metric not recorded while the debug span was active",
  );

  await Sentry.close();
});

test("debug OFF: rpcHook records the metric but creates no span/envelope", async () => {
  initSentry({ ...baseArgv, debug: false });
  const rec = recordingMetricsSdk();
  metrics.init({
    Sentry: rec.sdk,
    platform: "android",
    deviceClass: "mid",
    osMajor: "android.14",
    applicationUsageData: true,
  });

  const captured = [];
  setSink((frame) => captured.push(frame));

  const hook = rpcHook();
  assert.ok(
    hook,
    "rpcHook returned undefined — should still wrap for the metric path",
  );

  const nextCalled = await driveHook(hook);
  await flush(500);

  assert.ok(nextCalled, "rpcHook did not invoke next()");
  assert.equal(
    captured.length,
    0,
    "debug-off must not create an rpc.server transaction envelope",
  );
  assert.ok(
    rec.distributions.some(
      (d) => d.name === "comapeo.rpc.server.duration_ms",
    ),
    "rpc.server metric must be recorded on the debug-off path",
  );

  await Sentry.close();
});

test("debug OFF: a rejecting RPC records the duration metric but captures no issue", async () => {
  initSentry({ ...baseArgv, debug: false });
  const rec = recordingMetricsSdk();
  metrics.init({
    Sentry: rec.sdk,
    platform: "android",
    deviceClass: "mid",
    osMajor: "android.14",
    applicationUsageData: true,
  });

  const captured = [];
  setSink((frame) => captured.push(frame));

  const hook = rpcHook();
  assert.ok(hook, "rpcHook returned undefined — Sentry didn't initialise");

  // The hook observes errors for metrics only; capturing an issue is the
  // caller's decision, so a rejection must NOT produce an envelope.
  await new Promise((resolve) => {
    hook(
      { method: ["read", "doc"], args: [], metadata: {} },
      async () => {
        setImmediate(resolve);
        throw new Error("boom");
      },
    );
  });
  await flush(500);

  assert.equal(
    captured.length,
    0,
    "the hook must not capture RPC errors as Sentry issues",
  );
  assert.ok(
    rec.distributions.some(
      (d) => d.name === "comapeo.rpc.server.duration_ms",
    ),
    "the error path must still record the duration metric",
  );

  await Sentry.close();
});
