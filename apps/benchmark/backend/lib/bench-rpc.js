// Path-import; same framing as production by design — see index.js.
import { ServerHelper } from "../../../../backend/lib/server-helper.js";
import { SocketMessagePort } from "../../../../backend/lib/message-port.js";
import { startSpan } from "./telemetry-sink.js";

// Cache `"x".repeat(N)` per size so a mixed-size sweep doesn't spend
// its time in String.repeat rather than measuring the bridge. Capped
// to bound resident memory.
/** @type {Map<number, string>} */
const payloadCache = new Map();
const MAX_CACHED_PAYLOAD_BYTES = 4 * 1024 * 1024;

/** @param {number} sizeBytes */
function payload(sizeBytes) {
  const n = Math.max(0, Math.floor(sizeBytes));
  if (n > MAX_CACHED_PAYLOAD_BYTES) return "x".repeat(n);
  let s = payloadCache.get(n);
  if (!s) {
    s = "x".repeat(n);
    payloadCache.set(n, s);
  }
  return s;
}

/**
 * Bench RPC server. Same length-prefixed JSON framing as production's
 * `ComapeoRpcServer` (via `SocketMessagePort`) so the UDS layer is
 * exercised identically — only the dispatch table differs.
 *
 * Wire:
 *   { id, method: "echo" | "payload" | "ingestSpans", params? }
 *   → { id, result } | { id, error: { message } }
 *
 * `echo`/`payload` requests emit an `op:"rpc"` span with
 * `rttSide:"backend"` and `bytes`; the RN side records a paired
 * `rttSide:"rn"` span so the summarizer can diff bridge overhead.
 *
 * `ingestSpans` is intentionally not timed — its body is a bulk
 * `console.log` flush that would dominate the percentiles.
 */
export class BenchRpcServer extends ServerHelper {
  /** @param {{ sink: import("./telemetry-sink.js").TelemetrySink }} options */
  constructor({ sink }) {
    super((socket) => this.#onConnection(socket));
    /** @type {import("./telemetry-sink.js").TelemetrySink} */
    this.sink = sink;
  }

  /** @param {import('node:net').Socket} socket */
  #onConnection(socket) {
    const port = new SocketMessagePort(socket);
    port.on("message", (msg) => this.#handleRequest(port, msg));
    port.on("messageerror", (err) => {
      console.error("BenchRpcServer: client sent invalid message", err);
    });
    port.start();
  }

  /**
   * @param {SocketMessagePort} port
   * @param {unknown} msg
   */
  #handleRequest(port, msg) {
    if (
      !msg ||
      typeof msg !== "object" ||
      typeof (/** @type {any} */ (msg).id) !== "string" ||
      typeof (/** @type {any} */ (msg).method) !== "string"
    ) {
      console.warn("BenchRpcServer: malformed request, ignoring", msg);
      return;
    }
    const { id, method, params } =
      /** @type {{ id: string, method: string, params?: unknown }} */ (msg);

    // ingestSpans is the bulk-flush at end of run — measuring it would dominate.
    const measure = method !== "ingestSpans";
    const span = measure ? startSpan(this.sink, "rpc", `rpc.${method}`) : null;
    /** @type {unknown} */
    let result;
    /** @type {{ message: string } | undefined} */
    let error;
    try {
      result = this.#invoke(method, params);
    } catch (e) {
      error = { message: e instanceof Error ? e.message : String(e) };
    }
    if (span) {
      const responseBytes =
        typeof result === "string"
          ? result.length
          : result == null
            ? 0
            : JSON.stringify(result).length;
      span.end({ bytes: responseBytes, error: !!error, rttSide: "backend" });
    }

    port.postMessage(error ? { id, error } : { id, result });
  }

  /**
   * @param {string} method
   * @param {unknown} params
   */
  #invoke(method, params) {
    switch (method) {
      case "echo":
        return params ?? null;
      case "payload": {
        const sizeBytes =
          params &&
          typeof params === "object" &&
          "sizeBytes" in params &&
          typeof (/** @type {any} */ (params).sizeBytes) === "number"
            ? /** @type {{ sizeBytes: number }} */ (params).sizeBytes
            : 64;
        return payload(sizeBytes);
      }
      case "ingestSpans": {
        // Re-emit RN-side RTT spans via nodejs-mobile stdout so they
        // surface through the same logcat / os_log path as boot spans.
        // RN's own `console.log` is suppressed by RCTLog's level filter
        // in iOS release builds; routing through here bypasses it.
        const spans = /** @type {any} */ (params)?.spans;
        if (Array.isArray(spans)) {
          for (const span of spans) {
            console.log("BENCH_SPAN " + JSON.stringify(span));
          }
          return { count: spans.length };
        }
        return { count: 0 };
      }
      default:
        throw new Error(`Unknown bench RPC method: ${method}`);
    }
  }
}
