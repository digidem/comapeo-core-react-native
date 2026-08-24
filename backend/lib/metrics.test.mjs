import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { runtimeVersion } from "./memory-snapshot.js";
import * as metrics from "./metrics.js";

/**
 * Unit tests for the backend metrics layer. A fake
 * `Sentry.metrics` records every call so we can assert on metric names,
 * units, shared-attribute injection, the cardinality split, no-op when
 * off, and the forbidden-tag filter — without standing up the real SDK.
 */

function fakeSentry() {
  const calls = { distribution: [], count: [], gauge: [] };
  return {
    calls,
    sdk: {
      metrics: {
        distribution: (name, value, data) =>
          calls.distribution.push({ name, value, ...data }),
        count: (name, value, data) =>
          calls.count.push({ name, value, ...data }),
        gauge: (name, value, data) =>
          calls.gauge.push({ name, value, ...data }),
      },
    },
  };
}

/** A `memorySnapshot()` shaped fixture; Android values by default. */
function snapshot(overrides = {}) {
  return {
    runtime: "24.19.0-0",
    heap: {
      usedBytes: 16_598_748,
      physicalBytes: 27_484_160,
      totalBytes: 35_233_792,
      limitBytes: 569_114_624,
      externalBytes: 10_081_653,
    },
    process: {
      rssBytes: 192_600 * 1024,
      peakRssBytes: 261_000 * 1024,
      anonBytes: 92_500 * 1024,
      fileBytes: 99_100 * 1024,
      swapBytes: 26_500 * 1024,
    },
    ...overrides,
  };
}

function initWith(sdk, overrides = {}) {
  metrics.init({
    Sentry: sdk,
    platform: "android",
    deviceClass: "mid",
    osMajor: "android.14",
    applicationUsageData: true,
    ...overrides,
  });
}

beforeEach(() => metrics.resetForTests());

test("no-ops entirely when Sentry is off (init never ran)", () => {
  // No init → no SDK. Calls must not throw and record nothing.
  metrics.rpcServer("read.doc", "ok", 12);
  metrics.backendMemorySample(snapshot(), "boot");
  metrics.storageSizeBucket("<10MB");
  // Nothing to assert beyond "did not throw"; the absence of an SDK is
  // the whole point.
  assert.ok(true);
});

test("rpcServer emits one metric with status + device tags; method is usage-gated", () => {
  // Usage on: `method` rides on the single metric.
  const on = fakeSentry();
  initWith(on.sdk, { applicationUsageData: true });
  metrics.rpcServer("observation.create", "ok", 42);

  assert.equal(on.calls.distribution.length, 1);
  const [m] = on.calls.distribution;
  assert.equal(m.name, "comapeo.rpc.server.duration_ms");
  assert.equal(m.unit, "millisecond");
  assert.equal(m.attributes.status, "ok");
  assert.equal(m.attributes.platform, "android");
  assert.equal(m.attributes.device_class, "mid");
  assert.equal(m.attributes.os_major, "android.14");
  assert.equal(m.attributes.method, "observation.create");

  // Usage off: same single metric, but `method` is dropped (privacy gate).
  metrics.resetForTests();
  const off = fakeSentry();
  initWith(off.sdk, { applicationUsageData: false });
  metrics.rpcServer("observation.create", "ok", 42);

  assert.equal(off.calls.distribution.length, 1);
  assert.equal(off.calls.distribution[0].name, "comapeo.rpc.server.duration_ms");
  assert.equal(off.calls.distribution[0].attributes.method, undefined);
  assert.equal(off.calls.distribution[0].attributes.device_class, "mid");
});

test("syncSession emits one duration metric; peers/bytes buckets are usage-gated", () => {
  const off = fakeSentry();
  initWith(off.sdk, { applicationUsageData: false });
  metrics.syncSession("complete", 1200, "1-3", "1-10M");
  // One duration distribution (with device tags); no buckets when usage off.
  assert.equal(off.calls.distribution.length, 1);
  assert.equal(
    off.calls.distribution[0].name,
    "comapeo.sync.session.duration_ms",
  );
  assert.equal(off.calls.distribution[0].attributes.device_class, "mid");
  assert.equal(off.calls.count.length, 0);

  metrics.resetForTests();
  const on = fakeSentry();
  initWith(on.sdk, { applicationUsageData: true });
  metrics.syncSession("complete", 1200, "1-3", "1-10M");
  assert.equal(on.calls.distribution.length, 1);
  assert.deepEqual(
    on.calls.count.map((c) => c.name),
    ["comapeo.sync.session.peers_bucket", "comapeo.sync.bytes_bucket"],
  );
});

test("backendMemorySample emits the heap gauges in bytes, tagged by runtime", () => {
  const { sdk, calls } = fakeSentry();
  initWith(sdk);
  // No `process` block — this is the iOS shape, where node shares the app
  // process so an rss would describe the UI too.
  metrics.backendMemorySample(snapshot({ process: null }), "interval");
  assert.deepEqual(
    calls.gauge.map((g) => g.name),
    ["comapeo.backend.heap_used_bytes", "comapeo.backend.heap_physical_bytes"],
  );
  assert.ok(calls.gauge.every((g) => g.unit === "byte"));
  // The config value, shared with the `nodejs_mobile` event tag — not the
  // snapshot's own `runtime`, which the fixture sets to something else.
  assert.ok(calls.gauge.every((g) => g.attributes.runtime === runtimeVersion()));
});

test("backendMemorySample carries device tags — the slice memory is about", () => {
  const { sdk, calls } = fakeSentry();
  initWith(sdk);
  metrics.backendMemorySample(snapshot(), "interval");
  assert.ok(
    calls.gauge.every(
      (g) => g.attributes.device_class === "mid" && g.attributes.os_major === "android.14",
    ),
  );
});

test("backendMemorySample marks which call site sampled", () => {
  const { sdk, calls } = fakeSentry();
  initWith(sdk);
  metrics.backendMemorySample(snapshot(), "boot");
  metrics.backendMemorySample(snapshot(), "interval");
  assert.equal(calls.gauge.length, 8);
  assert.ok(calls.gauge.slice(0, 4).every((g) => g.attributes.sample === "boot"));
  assert.ok(
    calls.gauge.slice(4).every((g) => g.attributes.sample === "interval"),
  );
});

test("backendMemorySample adds the rss pair where node owns the process", () => {
  const { sdk, calls } = fakeSentry();
  initWith(sdk);
  metrics.backendMemorySample(snapshot(), "interval");
  assert.deepEqual(
    calls.gauge.map((g) => g.name),
    [
      "comapeo.backend.heap_used_bytes",
      "comapeo.backend.heap_physical_bytes",
      "comapeo.backend.rss_bytes",
      "comapeo.backend.rss_peak_bytes",
    ],
  );
  const peak = calls.gauge.find((g) => g.name === "comapeo.backend.rss_peak_bytes");
  assert.equal(peak.value, 261_000 * 1024);
});

test("before_metric_send filter drops a forbidden tag name routed through count()", () => {
  const { sdk, calls } = fakeSentry();
  initWith(sdk);
  // No public call site accepts a forbidden tag name, so drive the
  // wrapper directly: this fails if the tagName branch of
  // isForbiddenMetric (before-send.js) is removed.
  metrics.__testInternals.count("comapeo.x", { project_id: "p" });
  assert.equal(
    calls.count.length,
    0,
    "metric carrying a forbidden tag NAME must be dropped",
  );
  // A forbidden metric NAME is dropped too.
  metrics.__testInternals.count("project_id", { method: "read.doc" });
  assert.equal(calls.count.length, 0, "forbidden metric NAME must be dropped");
  // A clean metric still records.
  metrics.__testInternals.count("comapeo.x", { method: "read.doc" });
  assert.equal(calls.count.length, 1, "a clean metric still records");
});

test("before_metric_send drops forbidden tag VALUES (lat/lng shape)", () => {
  const { sdk, calls } = fakeSentry();
  initWith(sdk);
  // A lat/lng-shaped value must be dropped by the forbidden-value filter
  // even though `bucket` is an allowed tag name.
  metrics.storageSizeBucket("lat=12.34");
  assert.equal(
    calls.count.length,
    0,
    "metric carrying a lat/lng tag value must be dropped",
  );
  // A normal bucket value passes. (Deliberately no value-shape rule for
  // bare tokens — see the SCRUB_PATTERNS note in src/sentry-scrub.ts; the
  // `rootkey` tag-NAME ban covers the realistic mistake.)
  metrics.storageSizeBucket("<10MB");
  assert.equal(calls.count.length, 1);
});

test("bucketing helpers match the spec thresholds", () => {
  assert.equal(metrics.peersBucket(0), "0");
  assert.equal(metrics.peersBucket(1), "1-3");
  assert.equal(metrics.peersBucket(4), "4-10");
  assert.equal(metrics.peersBucket(50), "10+");
  assert.equal(metrics.bytesBucket(500_000), "<1M");
  assert.equal(metrics.bytesBucket(5_000_000), "1-10M");
  assert.equal(metrics.storageBucket(5_000_000), "<10MB");
  assert.equal(metrics.storageBucket(2_000_000_000), ">1GB");
});
