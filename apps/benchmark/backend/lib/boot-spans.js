import { startSpan } from "./telemetry-sink.js";

// Names match the Sentry plan §7.4.2 taxonomy so production
// instrumentation can adopt them without breaking dashboards.
/** @typedef {"listen-control" | "init" | "construct"} BootPhase */

/**
 * @param {import("./telemetry-sink.js").TelemetrySink} sink
 * @param {BootPhase} phase
 * @param {Record<string, unknown>} [attrs]
 */
export function startBootSpan(sink, phase, attrs) {
  return startSpan(sink, "boot", `boot.${phase}`, attrs);
}
