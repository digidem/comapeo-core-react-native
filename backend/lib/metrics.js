// Backend Sentry metrics layer (Phase 11 §11.2 / §11.6).
//
// Thin wrappers around `Sentry.metrics.*` that:
//   - inject the shared `platform` attribute on every metric so a call
//     site can never forget it;
//   - attach `device_class` / `os_major` only on the `.by_device`
//     mirror metrics (the cardinality split is enforced here, at the
//     API boundary — see §11.2.c);
//   - no-op entirely when Sentry is off (`init` never ran);
//   - run a defensive `before_metric_send` filter that drops any
//     emission carrying a forbidden attribute (§11.8).
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

/** The only tag cheap enough to ride on every metric (§11.2.c). */
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
 * Primary `…duration_ms{method,status}` + `…by_device{status}` mirror.
 *
 * @param {string} method
 * @param {string} status
 * @param {number} ms
 */
export function rpcServer(method, status, ms) {
  distribution("comapeo.rpc.server.duration_ms", ms, "millisecond", {
    method,
    status,
  });
  distribution(
    "comapeo.rpc.server.duration_ms.by_device",
    ms,
    "millisecond",
    { status, ...deviceTags() },
  );
}

/**
 * @param {string} method
 * @param {string} errorClass
 */
export function rpcServerError(method, errorClass) {
  count("comapeo.rpc.server.errors", { method, error_class: errorClass });
}

// ── Boot / shutdown ─────────────────────────────────────────────

/**
 * Primary `…phase_duration_ms{phase}` + `…by_device{phase}` mirror.
 *
 * @param {string} phase
 * @param {number} ms
 */
export function bootPhase(phase, ms) {
  distribution("comapeo.boot.phase_duration_ms", ms, "millisecond", {
    phase,
  });
  distribution(
    "comapeo.boot.phase_duration_ms.by_device",
    ms,
    "millisecond",
    { phase, ...deviceTags() },
  );
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
 * Three writes: duration distribution + by_device mirror, peers bucket
 * counter, bytes bucket counter.
 *
 * @param {string} outcome
 * @param {number} ms
 * @param {string} peersBucket
 * @param {string} bytesBucket
 */
export function syncSession(outcome, ms, peersBucket, bytesBucket) {
  distribution("comapeo.sync.session.duration_ms", ms, "millisecond", {
    outcome,
  });
  distribution(
    "comapeo.sync.session.duration_ms.by_device",
    ms,
    "millisecond",
    { outcome, ...deviceTags() },
  );
  count("comapeo.sync.session.peers_bucket", { bucket: peersBucket });
  count("comapeo.sync.bytes_bucket", { bucket: bytesBucket });
}

// ── Backend health (60s sampler) ────────────────────────────────

/** Three gauges from `process.memoryUsage()` + an uptime gauge. */
export function backendMemorySample() {
  const metrics = api();
  if (!metrics) return;
  const mem = process.memoryUsage();
  gauge("comapeo.backend.memory_rss_bytes", mem.rss, "byte", {});
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

// ── Usage (gated on applicationUsageData) ───────────────────────

/** @param {string} name */
export function usageScreen(name) {
  if (!config?.applicationUsageData) return;
  count("comapeo.usage.screen", { screen: name });
}

/** @param {string} name */
export function usageFeature(name) {
  if (!config?.applicationUsageData) return;
  count("comapeo.usage.feature", { feature: name });
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
