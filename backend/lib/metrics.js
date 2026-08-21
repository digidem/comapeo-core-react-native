// Backend Sentry metrics layer.
//
// Thin wrappers around `Sentry.metrics.*` that:
//   - inject the shared `platform` attribute on every metric so a call
//     site can never forget it;
//   - attach the low-cardinality `device_class` / `os_major` tags to the
//     duration metrics (Sentry Application Metrics bills by volume, not
//     cardinality, so one metric with all the attributes you'd slice by
//     beats a primary + `.by_device` split — group-by does the slicing at
//     query time). `method` and the sync buckets stay usage-gated for
//     privacy, not cardinality;
//   - no-op entirely when Sentry is off (`init` never ran);
//   - run a defensive `before_metric_send` filter that drops any
//     emission carrying a forbidden attribute.
//
// Populated by `sentry.js`'s `init()`, which has the live SDK + the
// resolved device tags from argv. No static dep on `@sentry/node-core`
// so the chunk stays unloaded when Sentry is off.

import { isForbiddenMetric } from "../before-send.js";

/** @type {typeof import("@sentry/node-core") | null} */
let Sentry = null;
/**
 * @type {{
 *   platform: string,
 *   deviceClass: string,
 *   osMajor: string,
 *   applicationUsageData: boolean,
 * } | null}
 */
let config = null;

/**
 * @param {{
 *   Sentry: typeof import("@sentry/node-core"),
 *   platform: string,
 *   deviceClass: string,
 *   osMajor: string,
 *   applicationUsageData: boolean,
 * }} args
 */
export function init(args) {
  Sentry = args.Sentry;
  config = {
    platform: args.platform,
    deviceClass: args.deviceClass,
    osMajor: args.osMajor,
    applicationUsageData: args.applicationUsageData,
  };
}

/** Test seam — reset the singletons so a no-op assertion is clean. */
export function resetForTests() {
  Sentry = null;
  config = null;
}

/** Whether `init` ran — lets callers skip work whose only output is a
 *  metric that would otherwise be silently dropped when Sentry is off. */
export function isEnabled() {
  return Sentry !== null;
}

/** The only tag cheap enough to ride on every metric. */
function defaultTags() {
  return { platform: config?.platform ?? "unknown" };
}

function deviceTags() {
  return {
    device_class: config?.deviceClass ?? "unknown",
    os_major: config?.osMajor ?? "unknown",
  };
}

/** @returns {any} */
function api() {
  if (!Sentry) return null;
  return /** @type {any} */ (Sentry).metrics ?? null;
}

/**
 * @param {string} name
 * @param {number} value
 * @param {string} unit
 * @param {Record<string, string | number | boolean>} attributes
 */
function distribution(name, value, unit, attributes) {
  const metrics = api();
  if (!metrics) return;
  const attrs = { ...defaultTags(), ...attributes };
  if (isForbiddenMetric(name, attrs)) return;
  metrics.distribution?.(name, value, { unit, attributes: attrs });
}

/**
 * @param {string} name
 * @param {Record<string, string | number | boolean>} attributes
 */
function count(name, attributes) {
  const metrics = api();
  if (!metrics) return;
  const attrs = { ...defaultTags(), ...attributes };
  if (isForbiddenMetric(name, attrs)) return;
  metrics.count?.(name, 1, { attributes: attrs });
}

/**
 * @param {string} name
 * @param {number} value
 * @param {string} unit
 * @param {Record<string, string | number | boolean>} attributes
 */
function gauge(name, value, unit, attributes) {
  const metrics = api();
  if (!metrics) return;
  const attrs = { ...defaultTags(), ...attributes };
  if (isForbiddenMetric(name, attrs)) return;
  metrics.gauge?.(name, value, { unit, attributes: attrs });
}

// ── RPC ─────────────────────────────────────────────────────────

/**
 * Server-side handler latency. One distribution carrying `status` + device
 * tags, plus `method` when the usage tier is on. Sentry Application Metrics
 * bills by volume, not cardinality, so a single high-cardinality series is
 * cheaper and more queryable than a primary + `.by_device` split — slice by
 * `method` or `device_class` (or both) with group-by at query time. `method`
 * stays usage-gated for privacy, not cardinality.
 *
 * @param {string} method
 * @param {string} status
 * @param {number} ms
 */
export function rpcServer(method, status, ms) {
  const attrs = { status, ...deviceTags() };
  if (config?.applicationUsageData) attrs.method = method;
  distribution("comapeo.rpc.server.duration_ms", ms, "millisecond", attrs);
}

// ── Boot / shutdown ─────────────────────────────────────────────

/**
 * @param {string} phase
 * @param {number} ms
 */
export function bootPhase(phase, ms) {
  distribution("comapeo.boot.phase_duration_ms", ms, "millisecond", {
    phase,
    ...deviceTags(),
  });
}

/**
 * @param {"started" | "error"} outcome
 * @param {string} [errorPhase]
 */
export function bootOutcome(outcome, errorPhase) {
  /** @type {Record<string, string>} */
  const attrs = { outcome };
  if (errorPhase) attrs.error_phase = errorPhase;
  count("comapeo.boot.outcome", attrs);
}

/**
 * @param {string} phase
 * @param {number} ms
 */
export function shutdownPhase(phase, ms) {
  distribution("comapeo.shutdown.phase_duration_ms", ms, "millisecond", {
    phase,
  });
}

// ── Sync session ────────────────────────────────────────────────

/**
 * One duration distribution (`outcome` + device tags), plus the usage-gated
 * peers/bytes bucket counters.
 *
 * @param {string} outcome
 * @param {number} ms
 * @param {string} peersBucket
 * @param {string} bytesBucket
 */
export function syncSession(outcome, ms, peersBucket, bytesBucket) {
  distribution("comapeo.sync.session.duration_ms", ms, "millisecond", {
    outcome,
    ...deviceTags(),
  });
  // collaboration-scale + data-volume buckets are usage-gated (privacy).
  if (config?.applicationUsageData) {
    count("comapeo.sync.session.peers_bucket", { bucket: peersBucket });
    count("comapeo.sync.bytes_bucket", { bucket: bytesBucket });
  }
}

// ── Backend health (boot sample, then 60s sampler) ──────────────

/**
 * Backend footprint gauges.
 *
 * The heap pair is emitted everywhere: `heap_used_bytes` is the live object
 * graph, `heap_physical_bytes` the heap memory actually committed and
 * touched. The second is what tracks the process's anonymous RSS, so it is
 * the one that moves when the runtime's memory layout changes — a V8 build
 * flag can halve the first while barely denting the process, or the reverse,
 * and only having both tells you which happened.
 *
 * The RSS pair rides on `snapshot.process`, which is non-null only where
 * `/proc` exists **and** node owns the process — i.e. Android's
 * `:ComapeoCore`. On iOS node runs in-process, so an `rss` there would be the
 * whole app, not the backend; `memory-snapshot.js` returns null and these two
 * are simply not emitted. `rss_peak_bytes` is `VmHWM`, the high-water mark
 * that Android's low-memory killer effectively scores the process on.
 *
 * All four sit at the **diagnostic** tier, matching `heap_used_bytes`, which
 * has always been diagnostic. They describe the process's own resource use at
 * a fixed low cadence, name nothing the user did, and — measured at boot —
 * are overwhelmingly a property of the build and the device rather than of
 * the data. Free *device* memory is deliberately still absent: that lives in
 * the `node_resources` context and stays usage-tier, because read-at-capture
 * frequency is itself usage-shape data.
 *
 * `runtime` is the nodejs-mobile revision, the dimension you group by to
 * compare two runtime builds in the field. It is one value per shipped build
 * — low cardinality, and no more identifying than the app version already on
 * every event.
 *
 * These carry `device_class` / `os_major` too, unlike the duration metrics
 * where they are a nice-to-have. Memory is the metric whose whole point is
 * the low-RAM device: `heap_used_bytes` shipped without them and, three
 * months in, its 15k samples cannot answer "is the tail coming from cheap
 * hardware" at all — which is the only question worth asking of it.
 *
 * @param {import("./memory-snapshot.js").MemorySnapshot} snapshot
 */
export function backendMemorySample(snapshot) {
  const metrics = api();
  if (!metrics) return;
  const attrs = { ...deviceTags(), runtime: snapshot.runtime };
  gauge("comapeo.backend.heap_used_bytes", snapshot.heap.usedBytes, "byte", attrs);
  gauge(
    "comapeo.backend.heap_physical_bytes",
    snapshot.heap.physicalBytes,
    "byte",
    attrs,
  );
  if (!snapshot.process) return;
  gauge("comapeo.backend.rss_bytes", snapshot.process.rssBytes, "byte", attrs);
  gauge(
    "comapeo.backend.rss_peak_bytes",
    snapshot.process.peakRssBytes,
    "byte",
    attrs,
  );
}

/**
 * Per-window worst event-loop stall, in ms. A distribution (not a gauge) so
 * Sentry can compute fleet-level percentiles of the per-minute worst stall,
 * sliced by device class — "the loop stalls on device X". Carries device tags.
 *
 * @param {number} maxMs Worst event-loop delay in the sampling window (ms).
 */
export function eventLoopDelaySample(maxMs) {
  distribution(
    "comapeo.backend.event_loop_delay_ms",
    maxMs,
    "millisecond",
    deviceTags(),
  );
}

// ── Storage / IPC ───────────────────────────────────────────────

/** @param {string} bucket `<10MB` / `10-100MB` / `100MB-1GB` / `>1GB` */
export function storageSizeBucket(bucket) {
  count("comapeo.storage.size_bucket", { bucket });
}

/** @param {string} [errorClass] */
export function ipcError(errorClass) {
  count("comapeo.ipc.errors", { error_class: errorClass ?? "Error" });
}

/** Telemetry-forwarding failure (envelope sink threw / dropped). */
export function telemetryForwardingFailure() {
  count("comapeo.telemetry.forwarding_failures", {});
}

// ── Bucketing helpers (shared so RN + Node bucket identically) ───

/** @param {number} peers @returns {string} */
export function peersBucket(peers) {
  // A session can end without any peer ever connecting.
  if (peers <= 0) return "0";
  if (peers <= 3) return "1-3";
  if (peers <= 10) return "4-10";
  return "10+";
}

/** @param {number} bytes @returns {string} */
export function bytesBucket(bytes) {
  if (bytes < 1_000_000) return "<1M";
  if (bytes < 10_000_000) return "1-10M";
  if (bytes < 100_000_000) return "10-100M";
  return "100M+";
}

/** @param {number} bytes @returns {string} */
export function storageBucket(bytes) {
  if (bytes < 10_000_000) return "<10MB";
  if (bytes < 100_000_000) return "10-100MB";
  if (bytes < 1_000_000_000) return "100MB-1GB";
  return ">1GB";
}

/** Test-only seam: drive a forbidden NAME through the wrappers. */
export const __testInternals = { count, distribution, gauge };
