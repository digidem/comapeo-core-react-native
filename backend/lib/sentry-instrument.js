// Sentry instrumentation singletons, populated by `setupSentry` from
// loader.mjs when `--sentryDsn` is set. No static dep on `@sentry/node`
// — the SDK is injected so the rollup chunk stays unloaded otherwise.
// Every export here no-ops if `setupSentry` never runs.

import ensureError from "ensure-error";

/** @typedef {import("./sentry-frame.js").SentryFrame} SentryFrame */

/** @type {typeof import("@sentry/node") | null} */
let Sentry = null;
/** @type {{ rpcArgsBytes: number, captureApplicationData: boolean } | null} */
let config = null;
/** @type {((envelope: any) => SentryFrame) | null} */
let envelopeToFrame = null;
/** @type {((frame: SentryFrame) => void) | null} */
let sink = null;

// Frames captured before `setSink` runs sit in this ring buffer and
// drain on registration.
const PRE_LISTEN_QUEUE_MAX = 100;
/** @type {SentryFrame[]} */
const preListenQueue = [];

/**
 * Must run before `forwardingTransport` actually fires (first envelope);
 * the transport closure reads these lazily, so passing it to
 * `Sentry.init` before this call is fine.
 *
 * @param {{
 *   Sentry: typeof import("@sentry/node"),
 *   config: { rpcArgsBytes: number, captureApplicationData: boolean },
 *   envelopeToFrame: (envelope: any) => SentryFrame,
 * }} args
 */
export function setupSentry(args) {
  Sentry = args.Sentry;
  config = args.config;
  envelopeToFrame = args.envelopeToFrame;
}

/**
 * Routes envelopes to the registered sink or buffers them in the
 * pre-listen queue.
 */
export const forwardingTransport = () => ({
  /** @param {any} envelope */
  send: async (envelope) => {
    if (!envelopeToFrame) return {};
    const frame = envelopeToFrame(envelope);
    if (sink) {
      sink(frame);
    } else {
      if (preListenQueue.length >= PRE_LISTEN_QUEUE_MAX) {
        preListenQueue.shift();
      }
      preListenQueue.push(frame);
    }
    return {};
  },
  flush: async () => true,
});

/**
 * Wrap a boot phase: span + `.phase` tag for `handleFatal` attribution.
 * `name` matches the wire phase in `NodeJSService.{kt,swift}`. Pass
 * `op` when the dashboard label diverges; `span: false` keeps the phase
 * tag but skips span creation (for sub-30ms phases).
 *
 * @template T
 * @param {string} name
 * @param {() => Promise<T>} fn
 * @param {{ op?: string, span?: boolean }} [options]
 * @returns {Promise<T>}
 */
export async function bootPhase(name, fn, options = {}) {
  const op = options.op ?? `boot.${name}`;
  if (!Sentry || options.span === false) {
    try {
      return await fn();
    } catch (e) {
      throw ensureErrorWithPhase(e, name);
    }
  }
  // op:boot.* is the Discover filter; name=op so span.name renders.
  return Sentry.startSpan({ name: op, op }, async (span) => {
    try {
      const r = await fn();
      span.setStatus({ code: 1, message: "ok" });
      return r;
    } catch (e) {
      span.setStatus({ code: 2, message: "internal_error" });
      throw ensureErrorWithPhase(e, name);
    }
  });
}

/**
 * @param {unknown} e
 * @param {string} phase
 */
function ensureErrorWithPhase(e, phase) {
  const error = ensureError(e);
  Object.defineProperty(error, "phase", {
    value: phase,
    enumerable: false,
    configurable: true,
  });
  return /** @type {Error & { phase: string }} */ (error);
}

/**
 * Capture a fatal with phase + source tags. try/catch because
 * `handleFatal` must still broadcast + exit even if Sentry throws.
 *
 * @param {string} phase
 * @param {Error} err
 * @param {string} source
 */
export function captureFatal(phase, err, source) {
  if (!Sentry) return;
  try {
    Sentry.captureException(err, { tags: { phase, source } });
  } catch (captureErr) {
    console.error("Failed to capture Sentry event", captureErr);
  }
}

/**
 * Resolves to `true` when off so callers can `await` unconditionally.
 *
 * @param {number} maxMs
 * @returns {Promise<boolean>}
 */
export function flush(maxMs) {
  if (!Sentry) return Promise.resolve(true);
  return Sentry.flush(maxMs).catch(() => false);
}

/**
 * Drains anything buffered during boot.
 *
 * @param {(frame: SentryFrame) => void} realSink
 */
export function setSink(realSink) {
  if (!Sentry) return;
  sink = realSink;
  while (preListenQueue.length > 0) {
    const frame = preListenQueue.shift();
    try {
      realSink(frame);
    } catch {
      // Sink threw — drop the rest rather than retrying forever.
      break;
    }
  }
}

/**
 * `onRequestHook` for ComapeoRpcServer. RPC args capture is opt-in
 * (PII) via `--sentryRpcArgsBytes`. Errors are not rethrown:
 * rpc-reflector already responds, and rethrowing would route routine
 * RPC errors into `handleFatal`.
 *
 * @returns {((request: any, next: any) => void) | undefined}
 */
export function makeRpcHook() {
  if (!Sentry) return undefined;
  const rpcArgsBytes = config?.rpcArgsBytes ?? 0;
  return (request, next) => {
    const sentryTrace = request.metadata?.["sentry-trace"];
    const baggage = request.metadata?.baggage;
    /** @type {Record<string, string>} */
    const attributes = { "rpc.method": request.method.join(".") };
    if (rpcArgsBytes > 0) {
      try {
        const stringified = JSON.stringify(request.args);
        attributes["rpc.args"] =
          stringified.length > rpcArgsBytes
            ? stringified.slice(0, rpcArgsBytes)
            : stringified;
      } catch {
        attributes["rpc.args"] = "<unserializable>";
      }
    }
    Sentry.continueTrace({ sentryTrace, baggage }, () => {
      Sentry.startSpan(
        {
          op: "rpc",
          name: request.method.join("."),
          forceTransaction: true,
          attributes,
        },
        async (span) => {
          try {
            await next(request);
            span.setStatus({ code: 1, message: "ok" });
          } catch (error) {
            span.setStatus({ code: 2, message: "internal_error" });
            Sentry.captureException(error, {
              tags: { layer: "node", op: "rpc" },
            });
          }
        },
      );
    });
  };
}

/**
 * Escape hatch. Prefer `bootPhase` / `captureFatal` / `makeRpcHook`
 * for consistent phase/tag attribution.
 *
 * @param {Error} err
 */
export function captureException(err) {
  if (!Sentry) return;
  Sentry.captureException(err);
}
