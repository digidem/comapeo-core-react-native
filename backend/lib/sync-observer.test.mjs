import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import * as Sentry from "@sentry/node-core";

import { initSentry } from "./sentry-init.js";
import { setSink, flush } from "./sentry.js";
import * as metrics from "./metrics.js";
import { watchSyncApi } from "./sync-observer.js";

/**
 * Sync-session lifecycle telemetry, driven through a fake `$sync`
 * (EventEmitter + getState, the surface `watchSyncApi` consumes) with
 * the REAL Sentry SDK — the same pattern as sentry.test.mjs:
 *
 *   - usage ON  ⇒ a `comapeo.sync.session` transaction envelope reaches
 *                 the sink even with the base traces rate at 0, carrying
 *                 ONLY the allowed bucketed attributes, plus the
 *                 duration metric and bucket counters;
 *   - usage OFF ⇒ no envelope; the duration metric still records
 *                 (diagnostic tier) and the bucket counters don't.
 */

const baseArgv = {
  sentryDsn: "https://x@sentry.io/1",
  sentryEnvironment: "test",
  sentryRelease: "0.0.0+test",
  sentrySampleRate: "1.0",
  // Deliberately absent → base traces rate 0. The sync-session
  // transaction must sample via the name-matched tracesSampler branch.
  sentryRpcArgsBytes: "0",
  sentryEnableLogs: false,
  sentryBaggage: "",
  debug: false,
  deviceClass: "mid",
  osMajor: "android.14",
  platformTag: "android",
};

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

function initMetrics(sdk, applicationUsageData) {
  metrics.init({
    Sentry: sdk,
    platform: "android",
    deviceClass: "mid",
    osMajor: "android.14",
    applicationUsageData,
  });
}

function fakeSyncApi(initialState) {
  const emitter = new EventEmitter();
  let state = initialState;
  return {
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    getState: () => state,
    setState(next) {
      state = next;
      emitter.emit("sync-state", next);
    },
  };
}

function deviceStates(n, { want = 0, wanted = 0 } = {}) {
  const out = {};
  for (let i = 0; i < n; i++) {
    out[`fakepeerid${i}`] = {
      initial: { isSyncEnabled: true, want: 0, wanted: 0 },
      data: { isSyncEnabled: true, want, wanted },
    };
  }
  return out;
}

function syncState({ dataEnabled, devices }) {
  return {
    initial: { isSyncEnabled: true },
    data: { isSyncEnabled: dataEnabled },
    remoteDeviceSyncState: devices,
  };
}

const idleState = syncState({ dataEnabled: false, devices: {} });

/** Extract the transaction payload from a base64 `sentry-envelope` frame. */
function decodeTransaction(frame) {
  const lines = Buffer.from(frame.data, "base64")
    .toString("utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  for (let i = 1; i < lines.length - 1; i++) {
    if (lines[i].type === "transaction") return lines[i + 1];
  }
  return undefined;
}

/** Drive one full discover → replicate → synced → autostop session. */
function driveCompletedSession(api) {
  // start() with no peers connected yet → discover phase.
  api.setState(syncState({ dataEnabled: true, devices: {} }));
  // Two peers connect with data outstanding → replicate phase.
  api.setState(
    syncState({ dataEnabled: true, devices: deviceStates(2, { wanted: 5 }) }),
  );
  // Everything transferred.
  api.setState(syncState({ dataEnabled: true, devices: deviceStates(2) }));
  // Autostop flips data sync off → session end.
  api.setState(syncState({ dataEnabled: false, devices: deviceStates(2) }));
}

test("usage ON: session emits a comapeo.sync.session transaction with only bucketed attributes", async () => {
  initSentry({ ...baseArgv, applicationUsageData: true });
  const rec = recordingMetricsSdk();
  initMetrics(rec.sdk, true);

  const captured = [];
  setSink((frame) => captured.push(frame));

  const api = fakeSyncApi(idleState);
  const detach = watchSyncApi(api);
  driveCompletedSession(api);
  detach();
  await flush(2000);

  const frames = captured.filter((f) => f.type === "sentry-envelope");
  const payloads = frames.map(decodeTransaction).filter(Boolean);
  assert.equal(payloads.length, 1, "expected exactly one transaction");
  const [payload] = payloads;
  assert.equal(payload.transaction, "comapeo.sync.session");

  // Attribute allowlist: our code sets only outcome + the two buckets;
  // anything else must be SDK-internal (sentry.* / otel.*).
  const data = payload.contexts?.trace?.data ?? {};
  assert.equal(data.outcome, "completed");
  assert.equal(data.peers_bucket, "1-3");
  assert.equal(data.bytes_bucket, "unknown");
  for (const key of Object.keys(data)) {
    assert.ok(
      ["outcome", "peers_bucket", "bytes_bucket"].includes(key) ||
        key.startsWith("sentry.") ||
        key.startsWith("otel."),
      `unexpected transaction attribute: ${key}`,
    );
  }

  // No peer identities anywhere in the payload.
  assert.ok(
    !JSON.stringify(payload).includes("fakepeerid"),
    "transaction payload leaked a peer id",
  );

  // Child spans: discover (pre-first-peer) then replicate.
  const ops = (payload.spans ?? []).map((s) => s.op);
  assert.deepEqual(ops.sort(), ["sync.discover", "sync.replicate"]);

  // Metrics from the same lifecycle: duration + usage-gated buckets.
  const duration = rec.distributions.find(
    (d) => d.name === "comapeo.sync.session.duration_ms",
  );
  assert.ok(duration, "duration metric not recorded");
  assert.equal(duration.attributes.outcome, "completed");
  assert.deepEqual(
    rec.counts.map((c) => [c.name, c.attributes.bucket]).sort(),
    [
      ["comapeo.sync.bytes_bucket", "unknown"],
      ["comapeo.sync.session.peers_bucket", "1-3"],
    ],
  );

  await Sentry.close();
});

test("usage OFF: no transaction envelope; duration metric still records, buckets don't", async () => {
  initSentry({ ...baseArgv, applicationUsageData: false });
  const rec = recordingMetricsSdk();
  initMetrics(rec.sdk, false);

  const captured = [];
  setSink((frame) => captured.push(frame));

  const api = fakeSyncApi(idleState);
  const detach = watchSyncApi(api);
  driveCompletedSession(api);
  detach();
  await flush(500);

  const transactions = captured
    .filter((f) => f.type === "sentry-envelope")
    .map(decodeTransaction)
    .filter(Boolean);
  assert.equal(
    transactions.length,
    0,
    "usage-off must not emit a sync-session transaction",
  );

  assert.ok(
    rec.distributions.some(
      (d) => d.name === "comapeo.sync.session.duration_ms",
    ),
    "diagnostic-tier duration metric must record with usage off",
  );
  assert.equal(rec.counts.length, 0, "bucket counters are usage-gated");

  await Sentry.close();
});

test("manual stop before synced records outcome=stopped; replicate-only spans when peers present at start", async () => {
  initSentry({ ...baseArgv, applicationUsageData: true });
  const rec = recordingMetricsSdk();
  initMetrics(rec.sdk, true);

  const captured = [];
  setSink((frame) => captured.push(frame));

  // Peers already connected when data sync starts → no discover phase.
  const api = fakeSyncApi(idleState);
  const detach = watchSyncApi(api);
  api.setState(
    syncState({ dataEnabled: true, devices: deviceStates(5, { want: 9 }) }),
  );
  // Stopped while blocks are still outstanding.
  api.setState(
    syncState({ dataEnabled: false, devices: deviceStates(5, { want: 4 }) }),
  );
  detach();
  await flush(2000);

  const payload = captured
    .filter((f) => f.type === "sentry-envelope")
    .map(decodeTransaction)
    .find(Boolean);
  assert.ok(payload, "no transaction envelope reached the sink");
  assert.equal(payload.contexts.trace.data.outcome, "stopped");
  assert.equal(payload.contexts.trace.data.peers_bucket, "4-10");
  assert.deepEqual(
    (payload.spans ?? []).map((s) => s.op),
    ["sync.replicate"],
  );

  const duration = rec.distributions.find(
    (d) => d.name === "comapeo.sync.session.duration_ms",
  );
  assert.equal(duration.attributes.outcome, "stopped");

  await Sentry.close();
});

test("session that never sees a peer buckets peers as 0", async () => {
  initSentry({ ...baseArgv, applicationUsageData: true });
  const rec = recordingMetricsSdk();
  initMetrics(rec.sdk, true);
  setSink(() => {});

  const api = fakeSyncApi(idleState);
  const detach = watchSyncApi(api);
  api.setState(syncState({ dataEnabled: true, devices: {} }));
  api.setState(syncState({ dataEnabled: false, devices: {} }));
  detach();
  await flush(500);

  const peersCount = rec.counts.find(
    (c) => c.name === "comapeo.sync.session.peers_bucket",
  );
  assert.equal(peersCount.attributes.bucket, "0");

  await Sentry.close();
});

test("watcher seeded from getState picks up a session already running", async () => {
  initSentry({ ...baseArgv, applicationUsageData: true });
  const rec = recordingMetricsSdk();
  initMetrics(rec.sdk, true);
  setSink(() => {});

  // Data sync already enabled when the watcher attaches.
  const api = fakeSyncApi(
    syncState({ dataEnabled: true, devices: deviceStates(1) }),
  );
  const detach = watchSyncApi(api);
  api.setState(syncState({ dataEnabled: false, devices: deviceStates(1) }));
  detach();
  await flush(500);

  const duration = rec.distributions.find(
    (d) => d.name === "comapeo.sync.session.duration_ms",
  );
  assert.ok(duration, "seeded session did not record on end");
  assert.equal(duration.attributes.outcome, "completed");

  await Sentry.close();
});
