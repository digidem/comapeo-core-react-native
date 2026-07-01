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

// ── Backend health (60s sampler) ────────────────────────────────

/**
 * Heap-used + uptime gauges. `rss` is intentionally omitted: node's `rss` is
 * the whole OS process, which on iOS is the entire app (node runs in-process),
 * so it wouldn't measure "the backend". `heapUsed` is the V8 JS heap and is
 * meaningful on both platforms.
 */
export function backendMemorySample() {
  const metrics = api();
  if (!metrics) return;
  const mem = process.memoryUsage();
  gauge("comapeo.backend.heap_used_bytes", mem.heapUsed, "byte", {});
  gauge("comapeo.fgs.uptime_s", process.uptime(), "second", {});
}

/** @param {number} delayMs Event-loop delay sample in milliseconds. */
export function eventLoopDelaySample(delayMs) {
  gauge("comapeo.backend.event_loop_delay_ms", delayMs, "millisecond", {});
}

// ── State / storage / IPC ───────────────────────────────────────

/**
 * @param {string} from
 * @param {string} to
 */
export function stateTransition(from, to) {
  count("comapeo.state.transitions", { from, to });
}

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
