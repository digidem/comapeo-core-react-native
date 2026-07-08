import { test } from "node:test";
import assert from "node:assert/strict";

import * as Sentry from "@sentry/node-core";

import { initSentry } from "./sentry-init.js";
import { rpcHook, setSink, flush, withSpan } from "./sentry.js";
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

/** Fake metrics SDK that records distribution/count calls instead of emitting. */
function recordingMetricsSdk() {
  const distributions = [];
  const counts = [];
  return {
    distributions,
    counts,
    sdk: {
      metrics: {
        distribution: (name, value, data) =>
          distributions.push({ name, value, ...data }),
        count: (name, value, data) => counts.push({ name, value, ...data }),
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

test("withSpan on a shutdown op records the shutdown phase metric", async () => {
  initSentry({ ...baseArgv, debug: false });
  const rec = recordingMetricsSdk();
  metrics.init({
    Sentry: rec.sdk,
    platform: "android",
    deviceClass: "mid",
    osMajor: "android.14",
    applicationUsageData: true,
  });

  await withSpan("shutdown.close-servers", async () => {});
  await withSpan("boot.manager-init", async () => {});

  const shutdown = rec.distributions.find(
    (d) => d.name === "comapeo.shutdown.phase_duration_ms",
  );
  assert.ok(shutdown, "shutdown phase metric not recorded via withSpan");
  assert.equal(shutdown.attributes.phase, "close-servers");
  assert.equal(shutdown.unit, "millisecond");
  assert.ok(shutdown.value >= 0);

  // Boot ops still route to the boot metric with the prefix stripped.
  const boot = rec.distributions.find(
    (d) => d.name === "comapeo.boot.phase_duration_ms",
  );
  assert.ok(boot, "boot phase metric not recorded via withSpan");
  assert.equal(boot.attributes.phase, "manager-init");

  await Sentry.close();
});

test("a throwing envelope sink records the telemetry forwarding-failure metric", async () => {
  initSentry({ ...baseArgv, debug: false });
  const rec = recordingMetricsSdk();
  metrics.init({
    Sentry: rec.sdk,
    platform: "android",
    deviceClass: "mid",
    osMajor: "android.14",
    applicationUsageData: true,
  });

  setSink(() => {
    throw new Error("sink boom");
  });

  // Real call path: capture → forwardingTransport.send → sink throws.
  Sentry.captureMessage("forwarding failure smoke");
  await flush(2000);

  assert.ok(
    rec.counts.some((c) => c.name === "comapeo.telemetry.forwarding_failures"),
    "sink throw must record comapeo.telemetry.forwarding_failures",
  );

  await Sentry.close();
});

test("initialScope carries the native-derived user.id on outgoing events", async () => {
  initSentry({ ...baseArgv, debug: false, sentryUserId: "e15e7255ae360358" });

  const captured = [];
  setSink((frame) => captured.push(frame));

  Sentry.captureMessage("user id smoke");
  await flush(2000);

  const eventFrame = captured.find((f) => f.type === "sentry-event");
  assert.ok(eventFrame, "no event frame reached the sink");
  assert.equal(
    eventFrame.payload.user?.id,
    "e15e7255ae360358",
    "event must carry the --sentryUserId value as user.id",
  );

  await Sentry.close();
});

test("usage tier ON: events carry a fresh node_resources context", async () => {
  initSentry({ ...baseArgv, applicationUsageData: true }, process.cwd());

  const captured = [];
  setSink((frame) => captured.push(frame));

  Sentry.captureMessage("node resources smoke");
  await flush(2000);

  const eventFrame = captured.find((f) => f.type === "sentry-event");
  assert.ok(eventFrame, "no event frame reached the sink");
  const resources = eventFrame.payload.contexts?.node_resources;
  assert.ok(resources, "usage tier must attach node_resources");
  assert.ok(resources.free_memory > 0, "free_memory must be a live read");
  assert.ok(resources.storage_size > 0, "storage_size must come from statfs");

  await Sentry.close();
});

test("usage tier OFF: events carry no node_resources context", async () => {
  initSentry({ ...baseArgv, applicationUsageData: false }, process.cwd());

  const captured = [];
  setSink((frame) => captured.push(frame));

  Sentry.captureMessage("node resources gated smoke");
  await flush(2000);

  const eventFrame = captured.find((f) => f.type === "sentry-event");
  assert.ok(eventFrame, "no event frame reached the sink");
  assert.equal(
    eventFrame.payload.contexts?.node_resources,
    undefined,
    "diagnostic tier must not attach node_resources",
  );

  await Sentry.close();
});
