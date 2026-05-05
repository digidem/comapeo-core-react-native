import { startSpan } from "./telemetry-sink.js";

/**
 * Names of every boot phase the Sentry plan §7.4.2 enumerates. Re-used
 * by the bench backend (see `backend/index.bench.js`) and intended to
 * be picked up by the production `backend/index.js` when Sentry plan
 * Phase 3 lands. Keeping the names identical means the same dashboards
 * work for both transports.
 *
 * Three of the six are server-side (Node) and three are native-side:
 *
 *   server-side (Node measures these):
 *     - listen-control
 *     - init
 *     - construct
 *
 *   native-side (Android/iOS measure these; deferred to Sentry plan):
 *     - ipc-connect (control)
 *     - rootkey-load
 *     - ipc-connect (comapeo)
 *
 * The bench backend only records the three server-side phases; the
 * native-side phases will be added when the production loaders adopt
 * shared instrumentation.
 *
 * @typedef {"listen-control"
 *   | "ipc-connect (control)"
 *   | "rootkey-load"
 *   | "init"
 *   | "construct"
 *   | "ipc-connect (comapeo)"} BootPhase
 */

/**
 * Open a `boot.<phase>` span on the given sink. Thin wrapper over
 * `startSpan` that fixes the `op` to `"boot"` and prefixes the name —
 * keeps every call site uniform and the phase name authoritative.
 *
 * @param {import("./telemetry-sink.js").TelemetrySink} sink
 * @param {BootPhase} phase
 * @param {Record<string, unknown>} [attrs]
 */
export function startBootSpan(sink, phase, attrs) {
  return startSpan(sink, "boot", `boot.${phase}`, attrs);
}
