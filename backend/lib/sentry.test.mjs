import { test } from "node:test";
import assert from "node:assert/strict";

import * as Sentry from "@sentry/core";

import { initSentry } from "./sentry-init.js";
import {
  rpcHook,
  setSink,
  flush,
  withSpan,
  withBootTrace,
  startSyncSessionTransaction,
} from "./sentry.js";
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
  debug: false,
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

  /** @type {any[]} */
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

  /** @type {any[]} */
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

  /** @type {any[]} */
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

  /** @type {any[]} */
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

  /** @type {any[]} */
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

  /** @type {any[]} */
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

/**
 * Trace-shape assertions. The tests above are deliberately
 * presence-not-shape, but the tracing backend changed (OpenTelemetry ->
 * `@sentry/core`'s own span tree), and shape is exactly what such a swap
 * can get wrong while still "working": trace continuation, explicit
 * `parentSpan` parenting, and the sync-session sampling exception.
 */

const INCOMING_TRACE_ID = "12345678901234567890123456789012";
const INCOMING_SPAN_ID = "1234567890123456";

/**
 * Envelope frames arrive base64'd; decode to `[itemHeader, payload]` pairs.
 * @param {any} frame
 * @returns {[any, any][]}
 */
function decodeEnvelopeItems(frame) {
  const lines = Buffer.from(frame.data, "base64")
    .toString("utf8")
    .split("\n")
    .filter(Boolean);
  /** @type {[any, any][]} */
  const items = [];
  // Line 0 is the envelope header; items alternate header/payload.
  for (let i = 1; i + 1 < lines.length + 1; i += 2) {
    if (!lines[i + 1]) break;
    items.push([JSON.parse(lines[i]), JSON.parse(lines[i + 1])]);
  }
  return items;
}

/**
 * Every transaction payload across the captured frames.
 * @param {any[]} frames
 * @returns {any[]}
 */
function transactionsFrom(frames) {
  return frames
    .filter((f) => f.type === "sentry-envelope")
    .flatMap(decodeEnvelopeItems)
    .filter(([header]) => header.type === "transaction")
    .map(([, payload]) => payload);
}

test("rpcHook continues the incoming trace and parents off its span", async () => {
  initSentry({ ...baseArgv, debug: true });
  /** @type {any[]} */
  const captured = [];
  setSink((frame) => captured.push(frame));

  const hook = rpcHook();
  assert.ok(hook, "rpcHook returned undefined — Sentry didn't initialise");
  await driveHook(hook);
  await flush(2000);

  const txn = transactionsFrom(captured).find(
    (t) => t.transaction === "read.doc",
  );
  assert.ok(txn, "no rpc.server transaction reached the sink");
  assert.equal(
    txn.contexts.trace.trace_id,
    INCOMING_TRACE_ID,
    "transaction did not adopt the incoming trace_id",
  );
  assert.equal(
    txn.contexts.trace.parent_span_id,
    INCOMING_SPAN_ID,
    "transaction did not parent off the incoming span_id",
  );

  await Sentry.close();
});

test("withBootTrace parents both children off the live loader-init span", async () => {
  initSentry({
    ...baseArgv,
    sentryTrace: `${INCOMING_TRACE_ID}-${INCOMING_SPAN_ID}-1`,
  });
  /** @type {any[]} */
  const captured = [];
  setSink((frame) => captured.push(frame));

  const loaderStartDate = new Date(Date.now() - 100);
  const sentinel = await withBootTrace(
    {
      argv: {
        ...baseArgv,
        sentryTrace: `${INCOMING_TRACE_ID}-${INCOMING_SPAN_ID}-1`,
      },
      loaderStartDate,
      importSentryNodeStartDate: new Date(Date.now() - 90),
      importSentryNodeEndDate: new Date(Date.now() - 50),
    },
    async () => "loaded",
  );
  assert.equal(sentinel, "loaded", "withBootTrace did not return loadIndex()");
  await flush(2000);

  const txn = transactionsFrom(captured).find(
    (t) => t.transaction === "boot.loader-init",
  );
  assert.ok(txn, "no boot.loader-init transaction reached the sink");
  assert.equal(
    txn.contexts.trace.trace_id,
    INCOMING_TRACE_ID,
    "boot trace did not continue the FGS-side trace",
  );

  const rootSpanId = txn.contexts.trace.span_id;
  for (const op of ["boot.loader-import-sentry-node", "boot.import-index"]) {
    const child = (/** @type {any[]} */ (txn.spans ?? [])).find(
      (s) => s.op === op,
    );
    assert.ok(child, `child span ${op} missing from the transaction`);
    assert.equal(
      child.parent_span_id,
      rootSpanId,
      `${op} did not parent off boot.loader-init`,
    );
  }

  await Sentry.close();
});

test("tracesSampler: base rate 0 still samples the sync-session transaction", async () => {
  initSentry({
    ...baseArgv,
    sentryTracesSampleRate: "0",
    applicationUsageData: true,
  });
  /** @type {any[]} */
  const captured = [];
  setSink((frame) => captured.push(frame));

  // Ordinary span at base rate 0 — must not be sampled.
  await withSpan("boot.sampled-out", async () => {});

  const session = startSyncSessionTransaction();
  assert.ok(session, "sync session handle was null at the usage tier");
  session.startPhase("discover");
  session.end({ outcome: "ok", peersBucket: "1", bytesBucket: "1k" });
  await flush(2000);

  const transactions = transactionsFrom(captured);
  assert.ok(
    transactions.some((t) => t.transaction === "comapeo.sync.session"),
    "sync-session transaction was dropped despite its sampler exception",
  );
  assert.ok(
    !transactions.some((t) => t.transaction === "boot.sampled-out"),
    "ordinary span was sampled despite a base rate of 0",
  );

  await Sentry.close();
});

test("discarded events are reported as a client_report on flush", async () => {
  // `sampleRate: 0` drops every event, so the client records the outcome.
  // Core never emits those on its own — `sentry-init.js` hooks the client's
  // `flush` to drain them — so this asserts the whole path, not just the flag.
  initSentry({ ...baseArgv, sentrySampleRate: "0" });
  /** @type {any[]} */
  const captured = [];
  setSink((frame) => captured.push(frame));

  Sentry.captureException(new Error("dropped by sample rate"));
  Sentry.captureException(new Error("also dropped"));
  await flush(2000);

  const report = captured
    .filter((f) => f.type === "sentry-envelope")
    .flatMap(decodeEnvelopeItems)
    .find(([header]) => header.type === "client_report");
  assert.ok(report, "no client_report envelope reached the sink");
  const discarded = (/** @type {any[]} */ (report[1].discarded_events)).find(
    (d) => d.reason === "sample_rate" && d.category === "error",
  );
  assert.ok(discarded, "client_report carried no sample_rate error outcome");
  assert.equal(discarded.quantity, 2, "wrong discarded-event count");

  await Sentry.close();
});
