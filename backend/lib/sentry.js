// SDK adapter. Singletons are populated by `init()` (called from
// `sentry-init.js`, itself dynamic-imported from `loader.mjs` only
// when `--sentryDsn` is set). No static dep on `@sentry/node-core-core` —
// the SDK is injected so the rollup chunk stays unloaded otherwise.
// Every export here no-ops if `init` never runs.

/** @typedef {import("./sentry-frame.js").SentryFrame} SentryFrame */

/**
 * parseArgs spec for the Sentry-related CLI flags. loader.mjs uses
 * this as the `options` for its single `parseArgs` call and forwards
 * the resulting `values` to `init` / `withBootTrace` unchanged.
 *
 * @satisfies {Record<string, { type: "string" | "boolean", default?: string | boolean }>}
 */
export const argSpec = {
  sentryDsn: { type: "string" },
  sentryEnvironment: { type: "string", default: "development" },
  sentryRelease: { type: "string" },
  sentrySampleRate: { type: "string", default: "1.0" },
  sentryTracesSampleRate: { type: "string" },
  sentryRpcArgsBytes: { type: "string", default: "0" },
  sentryEnableLogs: { type: "boolean", default: false },
  sentryTrace: { type: "string" },
  sentryBaggage: { type: "string", default: "" },
  captureApplicationData: { type: "boolean", default: false },
};

/**
 * @typedef {{
 *   sentryDsn?: string,
 *   sentryEnvironment: string,
 *   sentryRelease?: string,
 *   sentrySampleRate: string,
 *   sentryTracesSampleRate?: string,
 *   sentryRpcArgsBytes: string,
 *   sentryEnableLogs: boolean,
 *   sentryTrace?: string,
 *   sentryBaggage: string,
 *   captureApplicationData: boolean,
 * }} Argv
 */

/** @type {typeof import("@sentry/node-core") | null} */
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
 * Routes envelopes to the registered sink or buffers them in the
 * pre-listen queue. Wired into `Sentry.init` by `init()`.
 */
const forwardingTransport = () => ({
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

// Keep in sync with `src/sentry.ts`'s DEFAULT_TRACES_SAMPLE_RATE.
const DEFAULT_TRACES_SAMPLE_RATE = 0.1;

/**
 * Coerce a numeric CLI arg, throwing if native passed a non-finite
 * value. Loud-fail symmetric with `strict: true`.
 *
 * @param {string | number} raw
 */
function numericArg(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`Expected numeric arg, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/**
 * One-call setup: stores singletons AND calls `Sentry.init(...)`.
 * Caller has already verified `argv.sentryDsn` is set.
 *
 * @param {{
 *   Sentry: typeof import("@sentry/node-core"),
 *   argv: Argv,
 *   envelopeToFrame: (envelope: any) => SentryFrame,
 * }} args
 */
export function init({ Sentry: sdk, argv, envelopeToFrame: toFrame }) {
  Sentry = sdk;
  config = {
    rpcArgsBytes: numericArg(argv.sentryRpcArgsBytes),
    captureApplicationData: argv.captureApplicationData,
  };
  envelopeToFrame = toFrame;

  Sentry.init({
    dsn: argv.sentryDsn,
    environment: argv.sentryEnvironment,
    release: argv.sentryRelease,
    sampleRate: numericArg(argv.sentrySampleRate),
    tracesSampleRate: argv.captureApplicationData
      ? numericArg(argv.sentryTracesSampleRate ?? DEFAULT_TRACES_SAMPLE_RATE)
      : 0,
    // v9 moved this out of `_experiments` — keep the CLI flag name so
    // native doesn't have to change.
    enableLogs: argv.sentryEnableLogs,
    transport: forwardingTransport,
    // Function form preserves SDK defaults (inboundFilters, linkedErrors,
    // nodeContext, etc.) — the array form would replace them.
    integrations: (defaults) => [...defaults, Sentry.consoleIntegration()],
    initialScope: {
      tags: { proc: "fgs", layer: "node" },
    },
  });

  // Strip these so native processors fill them at capture (they skip
  // on non-null). Keep app (merges key-by-key) and runtime (Node-specific).
  Sentry.addEventProcessor((event) => {
    if (!event.contexts) return event;
    delete event.contexts.os;
    delete event.contexts.device;
    delete event.contexts.culture;
    return event;
  });
}

/**
 * Continue the FGS-side `boot.node-spawn` trace and wrap `loadIndex()`
 * in a `boot.loader-init` parent span with two children:
 * `boot.loader-import-sentry-node` (timed) and `boot.import-index`.
 * No-op (just runs `loadIndex()`) if Sentry is off or no trace header.
 *
 * @template T
 * @param {{
 *   argv: Argv,
 *   loaderStartDate: Date,
 *   importSentryNodeStartDate?: Date,
 *   importSentryNodeEndDate?: Date,
 * }} args
 * @param {() => Promise<T>} loadIndex
 * @returns {Promise<T>}
 */
export async function withBootTrace(args, loadIndex) {
  if (!Sentry || !args.argv.sentryTrace) return loadIndex();
  const sentryRef = Sentry;
  return sentryRef.continueTrace(
    { sentryTrace: args.argv.sentryTrace, baggage: args.argv.sentryBaggage },
    async () => {
      // Inactive + explicit `parentSpan` for both children: keeps ALS
      // at node-spawn during the `await loadIndex()`, so index.js's
      // IIFE captures node-spawn (not loader-init) for `boot.manager-init`.
      // loader-init must stay LIVE while children attach — passing an
      // already-ended span as `parentSpan` doesn't reliably parent
      // under @sentry/node-core's OTel backend.
      const loaderInitSpan = sentryRef.startInactiveSpan({
        name: "boot.loader-init",
        op: "boot.loader-init",
        startTime: args.loaderStartDate,
      });
      if (args.importSentryNodeStartDate && args.importSentryNodeEndDate) {
        sentryRef
          .startInactiveSpan({
            name: "boot.loader-import-sentry-node",
            op: "boot.loader-import-sentry-node",
            startTime: args.importSentryNodeStartDate,
            parentSpan: loaderInitSpan,
          })
          ?.end(args.importSentryNodeEndDate);
      }
      const importSpan = sentryRef.startInactiveSpan({
        name: "boot.import-index",
        op: "boot.import-index",
        parentSpan: loaderInitSpan,
      });
      try {
        return await loadIndex();
      } finally {
        importSpan?.end();
        loaderInitSpan?.end();
      }
    },
  );
}

/**
 * Wrap a callback in a Sentry span. Runs `fn` directly when Sentry is
 * off, so callers don't need to branch.
 *
 * @template T
 * @param {string} op
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withSpan(op, fn) {
  if (!Sentry) return fn();
  // op:boot.* is the Discover filter; name=op so span.name renders.
  return Sentry.startSpan({ name: op, op }, async (span) => {
    try {
      const r = await fn();
      span.setStatus({ code: 1, message: "ok" });
      return r;
    } catch (e) {
      span.setStatus({ code: 2, message: "internal_error" });
      throw e;
    }
  });
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
 * `onRequestHook` for ComapeoRpcServer. Returns `undefined` when off
 * so the RPC server skips middleware entirely. RPC args capture is
 * opt-in (PII) via `--sentryRpcArgsBytes`. Errors are not rethrown:
 * rpc-reflector already responds, and rethrowing would route routine
 * RPC errors into `handleFatal`.
 *
 * @returns {((request: any, next: any) => void) | undefined}
 */
export function rpcHook() {
  if (!Sentry) return undefined;
  const sentryRef = Sentry;
  const rpcArgsBytes = config?.rpcArgsBytes ?? 0;
  return (request, next) => {
    const sentryTrace = request.metadata?.["sentry-trace"];
    const baggage = request.metadata?.baggage;
    const method = request.method.join(".");
    // `rpc.system` / `rpc.method` follow OpenTelemetry's RPC semantic
    // conventions (https://opentelemetry.io/docs/specs/semconv/rpc/),
    // which Sentry defers to for RPC ops. Pair with `op: "rpc.server"`
    // here and `op: "rpc.client"` on the RN side.
    /** @type {Record<string, string>} */
    const attributes = {
      "rpc.system": "comapeo-ipc",
      "rpc.method": method,
    };
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
    sentryRef.continueTrace({ sentryTrace, baggage }, () => {
      sentryRef.startSpan(
        {
          op: "rpc.server",
          name: method,
          forceTransaction: true,
          attributes,
        },
        async (span) => {
          try {
            await next(request);
            span.setStatus({ code: 1, message: "ok" });
          } catch (error) {
            span.setStatus({ code: 2, message: "internal_error" });
            sentryRef.captureException(error, {
              tags: { layer: "node", op: "rpc.server" },
            });
          }
        },
      );
    });
  };
}
