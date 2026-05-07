import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

/**
 * Telemetry sink interface for bench spans. The eventual
 * `SentryAdapterSink` (Sentry plan §6.x) will implement the same shape.
 *
 * `recordSpan` MUST NOT throw — a bad sink cannot crash the backend
 * mid-bench. Errors are logged and swallowed.
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

/** Drops every span — measures the bench backend's own floor. */
export class NoopSink {
  recordSpan() {}
  close() {}
}

/**
 * One span per stdout line, prefixed `BENCH_SPAN ` so the host runner
 * can grep it out of pulled device logs (Android logcat / iOS console).
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
 * NDJSON-to-disk sink. Sync appends so a crash mid-bench doesn't lose
 * buffered spans. Bench app reads the file back to render results.
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
 * Merges per-process defaults onto a span. `runId` at top level (RN
 * convention); `device` into `attrs.device` (summarizer groups by it).
 * Span values win over defaults.
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
 * `--telemetry=<spec>` → sink. Unspecified or `log` → LogSink;
 * `noop` → NoopSink; `file:<path>` → JsonFileSink. Unknown throws so
 * a typo doesn't silently drop spans.
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
 * Open a span. Returns `{ end(extraAttrs?) }` that records on the sink.
 * `hrtime.bigint()` for sub-ms duration; `Date.now()` for wall-clock
 * start so spans correlate across device clock skew.
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
