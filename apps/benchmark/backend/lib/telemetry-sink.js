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
 * Default sink. Useful when telemetry is irrelevant to a given run
 * (e.g. local debugging where the bench app's on-device renderer is
 * the only consumer). Zero-overhead.
 *
 * @returns {TelemetrySink}
 */
export class NoopSink {
  recordSpan() {}
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
  /** @param {string} filePath */
  constructor(filePath) {
    this.filePath = filePath;
    mkdirSync(path.dirname(filePath), { recursive: true });
  }

  /** @param {BenchSpan} span */
  recordSpan(span) {
    try {
      appendFileSync(this.filePath, JSON.stringify(span) + "\n");
    } catch (e) {
      console.error("JsonFileSink: append failed", e);
    }
  }

  close() {}
}

/**
 * Fire-and-forget HTTP POST sink. Intended for orchestrated runs where
 * the bench app POSTs to a host-side receiver via the BrowserStack
 * Local tunnel. Failures are silently swallowed so the on-device
 * experience is unaffected when no receiver is reachable — that's
 * deliberate: the bench app must be useful standalone.
 *
 * @returns {TelemetrySink}
 */
export class HttpSink {
  /** @param {string} url */
  constructor(url) {
    this.url = url;
  }

  /** @param {BenchSpan} span */
  recordSpan(span) {
    // No await — we don't want sink latency on the hot path. Errors are
    // logged once per type to avoid flooding the console when the
    // receiver is down.
    fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(span),
    }).catch((e) => {
      if (!this._loggedError) {
        console.warn("HttpSink: POST failed (subsequent errors suppressed):", e?.message ?? e);
        this._loggedError = true;
      }
    });
  }

  close() {}
}

/**
 * Parses a `--telemetry=<spec>` CLI arg into a sink instance.
 *
 *   - `noop`              → NoopSink (also the fallback for unspecified)
 *   - `file:<path>`       → JsonFileSink writing NDJSON to `<path>`
 *   - `http://<url>`      → HttpSink POSTing each span as JSON
 *   - `https://<url>`     → ditto
 *
 * Unknown specs throw at startup so a typo doesn't silently drop spans.
 *
 * @param {string | undefined} spec
 * @returns {TelemetrySink}
 */
export function createSinkFromArg(spec) {
  if (!spec || spec === "noop") return new NoopSink();
  if (spec.startsWith("file:")) return new JsonFileSink(spec.slice("file:".length));
  if (spec.startsWith("http://") || spec.startsWith("https://")) return new HttpSink(spec);
  throw new Error(
    `Unknown --telemetry spec: ${spec}. Expected "noop", "file:<path>", or "http(s)://<url>".`,
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
