import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

/**
 * Telemetry sink interface used by the bench backend (and, eventually,
 * by the production backend once Sentry plan §6.x lands a
 * `SentryAdapterSink` implementing the same surface).
 *
 * Span shape:
 *   {
 *     op:   "boot" | "rpc",
 *     name: "boot.listen-control" | "boot.init" | "boot.construct"
 *           | "rpc.echo" | "rpc.payload" | ...,
 *     startTimestamp: number,   // ms since epoch
 *     durationMs:     number,   // sub-ms precision via process.hrtime.bigint
 *     attrs:          object,   // free-form per-call metadata (e.g. {bytes:1024})
 *   }
 *
 * Implementations MUST be non-throwing on `recordSpan` — a bad sink
 * cannot crash the backend mid-bench. Errors are logged and swallowed.
 *
 * @typedef {{
 *   op: "boot" | "rpc",
 *   name: string,
 *   startTimestamp: number,
 *   durationMs: number,
 *   attrs?: Record<string, unknown>,
 * }} BenchSpan
 *
 * @typedef {{
 *   recordSpan(span: BenchSpan): void,
 *   close(): Promise<void> | void,
 * }} TelemetrySink
 */

/**
 * Discards every span. Useful only when you want to confirm a run
 * works without any tracing overhead at all (e.g. measuring
 * "what's the floor of the bench backend itself").
 *
 * @returns {TelemetrySink}
 */
export class NoopSink {
  recordSpan() {}
  close() {}
}

/**
 * Writes one span per stdout line, prefixed with `BENCH_SPAN ` so a
 * downstream parser can distinguish them from regular log lines.
 * On Android this surfaces in `logcat` (under the `Comapeo:NodeJS`
 * tag for backend, `ReactNativeJS` for App.tsx); on iOS it lands in
 * the device console. BrowserStack captures both verbatim when the
 * build trigger sets `deviceLogs: true`, so the host runner just
 * grep's `BENCH_SPAN` out of the pulled log file post-build.
 *
 * Replaces the receiver/HTTP-tunnel approach as the default path for
 * BS dispatches: no BrowserStackLocal, no cleartext-traffic config,
 * no nodejs-mobile vs RN HTTP routing distinction. Both span sources
 * just write to stdout.
 *
 * @returns {TelemetrySink}
 */
export class LogSink {
  /**
   * @param {{ runId?: string, device?: string }} [defaults]
   */
  constructor(defaults = {}) {
    this.defaults = defaults;
  }

  /** @param {BenchSpan} span */
  recordSpan(span) {
    try {
      console.log("BENCH_SPAN " + JSON.stringify(mergeDefaults(span, this.defaults)));
    } catch (e) {
      console.error("LogSink: stringify failed", e);
    }
  }

  close() {}
}

/**
 * NDJSON-to-disk sink. One span per line; appends are sync so a process
 * crash mid-bench doesn't lose buffered spans. Used as the default
 * on-device transport: the bench app reads the file back to render the
 * results panel and offer "Export results".
 *
 * @returns {TelemetrySink}
 */
export class JsonFileSink {
  /**
   * @param {string} filePath
   * @param {{ runId?: string, device?: string }} [defaults]
   */
  constructor(filePath, defaults = {}) {
    this.filePath = filePath;
    this.defaults = defaults;
    mkdirSync(path.dirname(filePath), { recursive: true });
  }

  /** @param {BenchSpan} span */
  recordSpan(span) {
    try {
      appendFileSync(this.filePath, JSON.stringify(mergeDefaults(span, this.defaults)) + "\n");
    } catch (e) {
      console.error("JsonFileSink: append failed", e);
    }
  }

  close() {}
}

/**
 * Lifts per-process defaults onto a span before emit. `runId` lands at
 * top level (the RN side's convention). `device` tucks into
 * `attrs.device` so the summarizer can group spans across files
 * post-hoc. Span-supplied values win over defaults so per-call
 * overrides still work.
 *
 * @param {BenchSpan} span
 * @param {{ runId?: string, device?: string }} defaults
 */
function mergeDefaults(span, defaults) {
  /** @type {any} */
  const out = { ...span };
  if (defaults.runId && !("runId" in out)) {
    out.runId = defaults.runId;
  }
  if (defaults.device) {
    out.attrs = { device: defaults.device, ...(span.attrs ?? {}) };
  }
  return out;
}

/**
 * Parses a `--telemetry=<spec>` CLI arg into a sink instance.
 *
 *   - unspecified         → LogSink (the default; works in both
 *                           on-device standalone and BS dispatches)
 *   - `log`               → LogSink (explicit)
 *   - `noop`              → NoopSink (drops every span)
 *   - `file:<path>`       → JsonFileSink writing NDJSON to `<path>`
 *
 * Unknown specs throw at startup so a typo doesn't silently drop spans.
 *
 * @param {string | undefined} spec
 * @param {{ runId?: string, device?: string }} [defaults]
 * @returns {TelemetrySink}
 */
export function createSinkFromArg(spec, defaults = {}) {
  if (!spec || spec === "log") return new LogSink(defaults);
  if (spec === "noop") return new NoopSink();
  if (spec.startsWith("file:")) return new JsonFileSink(spec.slice("file:".length), defaults);
  throw new Error(
    `Unknown --telemetry spec: ${spec}. Expected "log", "noop", or "file:<path>".`,
  );
}

/**
 * Open a span. Returns an object with `.end(extraAttrs?)` that records
 * the span on the sink with measured duration.
 *
 * Uses `process.hrtime.bigint()` for sub-ms precision and Date.now() for
 * the wall-clock start timestamp (so spans can be correlated across
 * device clock skew when host-side aggregation is used).
 *
 * @param {TelemetrySink} sink
 * @param {"boot" | "rpc"} op
 * @param {string} name
 * @param {Record<string, unknown>} [attrs]
 */
export function startSpan(sink, op, name, attrs = {}) {
  const startTimestamp = Date.now();
  const startHr = process.hrtime.bigint();
  return {
    /** @param {Record<string, unknown>} [extraAttrs] */
    end(extraAttrs) {
      const elapsedNs = Number(process.hrtime.bigint() - startHr);
      sink.recordSpan({
        op,
        name,
        startTimestamp,
        durationMs: elapsedNs / 1e6,
        attrs: extraAttrs ? { ...attrs, ...extraAttrs } : attrs,
      });
    },
  };
}
