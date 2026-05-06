import { startSpan } from "./telemetry-sink.js";

/**
 * Server-side boot phases the bench backend records. Three matching
 * names from the Sentry plan §7.4.2 taxonomy so future production
 * instrumentation can land on the same span names without breaking
 * dashboards. Three more native-side phases (`ipc-connect (control)`,
 * `rootkey-load`, `ipc-connect (comapeo)`) live in the native loader
 * and are out of scope for the bench backend — they'll be added when
 * the production loaders adopt shared instrumentation.
 *
 * @typedef {"listen-control" | "init" | "construct"} BootPhase
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
