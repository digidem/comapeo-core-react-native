// Path-imported from the module's production backend — see
// apps/benchmark/backend/index.js for the rationale. Same wire framing
// as production, by design.
import { ServerHelper } from "../../../../backend/lib/server-helper.js";
import { SocketMessagePort } from "../../../../backend/lib/message-port.js";
import { startSpan } from "./telemetry-sink.js";

/**
 * Pre-allocated payload buffers, indexed by size class. A new bench run
 * with mixed sizes would otherwise spend its time in `String.repeat`
 * rather than measuring the bridge — this caches `"x".repeat(N)` once
 * per size encountered. Capped at 4 MiB to bound resident memory.
 *
 * @type {Map<number, string>}
 */
const payloadCache = new Map();
const MAX_CACHED_PAYLOAD_BYTES = 4 * 1024 * 1024;

/** @param {number} sizeBytes */
function payload(sizeBytes) {
  const n = Math.max(0, Math.floor(sizeBytes));
  if (n > MAX_CACHED_PAYLOAD_BYTES) {
    // Don't cache huge payloads; just synthesize and discard.
    return "x".repeat(n);
  }
  let s = payloadCache.get(n);
  if (!s) {
    s = "x".repeat(n);
    payloadCache.set(n, s);
  }
  return s;
}

/**
 * Minimal request/response RPC server for the benchmark bundle. Speaks
 * the same length-prefixed JSON framing as the production
 * `ComapeoRpcServer` (via `SocketMessagePort`) so the native UDS layer
 * is exercised identically — only the on-the-wire payload schema and
 * the dispatch table differ.
 *
 * Wire format:
 *   request:  { id: string, method: "echo" | "payload", params?: unknown }
 *   response: { id: string, result: unknown }
 *           | { id: string, error: { message: string } }
 *
 * Methods:
 *   - `echo(params)` returns `params` unchanged. Used for round-trip
 *     latency at the smallest payload class.
 *   - `payload({ sizeBytes })` returns an ASCII string of `sizeBytes`
 *     length. Used for per-size throughput measurements.
 *
 * Each request emits an `op:"rpc"` span on the supplied sink with the
 * server-side handler duration in `durationMs` and the response payload
 * size in `attrs.bytes`. RN-thread (round-trip) timing is recorded
 * separately on the bench app side so end-to-end vs. server-only timing
 * can be diffed.
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

    const span = startSpan(this.sink, "rpc", `rpc.${method}`);
    /** @type {unknown} */
    let result;
    /** @type {{ message: string } | undefined} */
    let error;
    try {
      result = this.#invoke(method, params);
    } catch (e) {
      error = { message: e instanceof Error ? e.message : String(e) };
    }
    const responseBytes =
      typeof result === "string"
        ? result.length
        : result == null
          ? 0
          : JSON.stringify(result).length;
    span.end({ bytes: responseBytes, error: !!error });

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
        // RN side accumulates RTT spans during the bench loop and
        // ships them all over the bench RPC socket once the run
        // completes. We re-emit each via `console.log` so they surface
        // through the same nodejs-mobile→logcat (Android) /
        // pipe→os_log (iOS) path the boot phases use. Why this round-
        // trip rather than RN's own `console.log`: in iOS release
        // builds, `RCTLog`'s default level filter (INFO suppressed)
        // means JS `console.log` never reaches the device console.
        // Routing through nodejs-mobile bypasses that filter entirely.
        // Called once per bench run, post-measurement, so the
        // round-trip cost doesn't contaminate the RTT samples.
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
