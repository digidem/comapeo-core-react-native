import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import * as metrics from "./metrics.js";

/**
 * Unit tests for the backend metrics layer (§11.2 / §11.8). A fake
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

function initWith(sdk, overrides = {}) {
  metrics.init({
    Sentry: sdk,
    platform: "android",
    deviceClass: "mid",
    osMajor: "android.14",
    applicationUsageData: false,
    ...overrides,
  });
}

beforeEach(() => metrics.resetForTests());

test("no-ops entirely when Sentry is off (init never ran)", () => {
  // No init → no SDK. Calls must not throw and record nothing.
  metrics.rpcServer("read.doc", "ok", 12);
  metrics.backendMemorySample();
  metrics.stateTransition("starting", "started");
  // Nothing to assert beyond "did not throw"; the absence of an SDK is
  // the whole point.
  assert.ok(true);
});

test("rpcServer injects platform and splits the by_device mirror", () => {
  const { sdk, calls } = fakeSentry();
  initWith(sdk);
  metrics.rpcServer("observation.create", "ok", 42);

  assert.equal(calls.distribution.length, 2);
  const [primary, mirror] = calls.distribution;

  assert.equal(primary.name, "comapeo.rpc.server.duration_ms");
  assert.equal(primary.unit, "millisecond");
  assert.equal(primary.attributes.method, "observation.create");
  assert.equal(primary.attributes.status, "ok");
  assert.equal(primary.attributes.platform, "android");
  // Primary metric must NOT carry device tags (cardinality split §11.2.c).
  assert.equal(primary.attributes.device_class, undefined);

  assert.equal(mirror.name, "comapeo.rpc.server.duration_ms.by_device");
  assert.equal(mirror.attributes.device_class, "mid");
  assert.equal(mirror.attributes.os_major, "android.14");
  assert.equal(mirror.attributes.platform, "android");
  // Mirror drops the question-specific `method` dimension.
  assert.equal(mirror.attributes.method, undefined);
});

test("backendMemorySample emits three gauges with byte/second units", () => {
  const { sdk, calls } = fakeSentry();
  initWith(sdk);
  metrics.backendMemorySample();
  const names = calls.gauge.map((g) => g.name);
  assert.deepEqual(names, [
    "comapeo.backend.memory_rss_bytes",
    "comapeo.backend.heap_used_bytes",
    "comapeo.fgs.uptime_s",
  ]);
  assert.equal(calls.gauge[0].unit, "byte");
  assert.equal(calls.gauge[2].unit, "second");
});

test("usage metrics no-op unless applicationUsageData is on", () => {
  const { sdk, calls } = fakeSentry();
  initWith(sdk, { applicationUsageData: false });
  metrics.usageScreen("ObservationList");
  assert.equal(calls.count.length, 0);

  metrics.resetForTests();
  const second = fakeSentry();
  initWith(second.sdk, { applicationUsageData: true });
  metrics.usageScreen("ObservationList");
  assert.equal(second.calls.count.length, 1);
  assert.equal(second.calls.count[0].name, "comapeo.usage.screen");
  assert.equal(second.calls.count[0].attributes.screen, "ObservationList");
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
  // A normal bucket value passes. (The broad base64-22 value rule is disabled
  // pending a narrower design — a bare token would also pass now.)
  metrics.storageSizeBucket("<10MB");
  assert.equal(calls.count.length, 1);
});

test("bucketing helpers match the spec thresholds", () => {
  assert.equal(metrics.peersBucket(1), "1-3");
  assert.equal(metrics.peersBucket(4), "4-10");
  assert.equal(metrics.peersBucket(50), "10+");
  assert.equal(metrics.bytesBucket(500_000), "<1M");
  assert.equal(metrics.bytesBucket(5_000_000), "1-10M");
  assert.equal(metrics.storageBucket(5_000_000), "<10MB");
  assert.equal(metrics.storageBucket(2_000_000_000), ">1GB");
});
