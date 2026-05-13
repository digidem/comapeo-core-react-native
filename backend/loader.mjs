// nodejs-mobile spawn target. `Sentry.init()` must run before
// `index.js`'s static imports so OpenTelemetry's import-in-the-middle
// hook can patch them.

// Local name `register` (not aliased) so `rollup-plugin-import-hook.mjs`'s
// `register('import-in-the-middle/hook.mjs', ...)` regex matches.
import { register } from "node:module";
import { parseArgs } from "node:util";

// Captured at first line so `boot.loader-init` covers everything from
// process spawn through Sentry.init.
const loaderStartDate = new Date();

const { values } = parseArgs({
  options: {
    sentryDsn: { type: "string" },
    sentryEnvironment: { type: "string" },
    sentryRelease: { type: "string" },
    sentrySampleRate: { type: "string" },
    sentryTracesSampleRate: { type: "string" },
    sentryRpcArgsBytes: { type: "string" },
    sentryEnableLogs: { type: "boolean" },
    sentryTrace: { type: "string" },
    sentryBaggage: { type: "string" },
    captureApplicationData: { type: "boolean", default: false },
  },
  allowPositionals: true,
  // Don't crash on unknown flags (e.g. native may add new ones later).
  strict: false,
});

// With `strict: false`, string options can land as boolean when a
// caller wrote `--foo` without a value. Coerce defensively.
/** @param {unknown} v */
const asString = (v) => (typeof v === "string" ? v : undefined);

const dsn = asString(values.sentryDsn);
const captureApplicationData = values.captureApplicationData === true;
const sentryTrace = asString(values.sentryTrace);
const sentryBaggage = asString(values.sentryBaggage);

/** @type {any} */
let Sentry = null;

if (dsn) {
  // Register iitm hook BEFORE importing @sentry/node so OTel
  // auto-instrumentations registered during init can patch modules
  // we import after. `@sentry/node@8`'s own `maybeInitializeEsmLoader`
  // is gated on `typeof require === 'undefined'`, which `esm-shim`'s
  // `createRequire` injection makes always-truthy in our bundle —
  // the SDK's call is dead code, so we have to register ourselves.
  // The string is rewritten to `'./importHook.js'` by
  // `rollup-plugin-import-hook.mjs` so it lands on the bundled hook.
  register("import-in-the-middle/hook.mjs", import.meta.url);

  // Dynamic import keeps the rollup chunk unloaded when Sentry is off.
  Sentry = await import("@sentry/node");
  // `serializeEnvelope` isn't re-exported from `@sentry/node`'s public
  // surface — import directly from `@sentry/core` (a peer dep of
  // `@sentry/node` and an explicit dep of this package).
  const { serializeEnvelope } = await import("@sentry/core");
  const { envelopeToFrame } = await import("./lib/sentry-frame.js");

  // Replace `@sentry/node`'s HTTP transport with a forwarder that ships
  // every captured payload to native over the control socket;
  // `sentry-android` / `sentry-cocoa` already run in the host process
  // with offline-capable transports. See `lib/sentry-frame.js` for the
  // event-vs-envelope routing and `docs/sentry-integration-plan.md` §5.7
  // for the wire protocol. `index.js` registers the real sink via
  // `__comapeoSentrySetSink` once the control socket binds; frames
  // emitted before then sit in a bounded ring buffer.
  /** @typedef {{type: "sentry-event", payload: any} | {type: "sentry-envelope", data: string}} SentryFrame */
  /** @type {((frame: SentryFrame) => void) | null} */
  let sink = null;
  const PRE_LISTEN_QUEUE_MAX = 100;
  /** @type {SentryFrame[]} */
  const preListenQueue = [];

  const forwardingTransport = () => ({
    /** @param {any} envelope */
    send: async (envelope) => {
      const frame = /** @type {SentryFrame} */ (
        envelopeToFrame(envelope, serializeEnvelope)
      );
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

  const tracesSampleRateRaw = asString(values.sentryTracesSampleRate);
  const sampleRateRaw = asString(values.sentrySampleRate);
  Sentry.init({
    dsn,
    environment: asString(values.sentryEnvironment) ?? "production",
    release: asString(values.sentryRelease),
    sampleRate: sampleRateRaw ? Number(sampleRateRaw) : 1.0,
    // Phase 5 gates tracing on the capture-application-data toggle;
    // until then this is always 0.
    tracesSampleRate: captureApplicationData
      ? Number(tracesSampleRateRaw ?? "0.1")
      : 0,
    _experiments:
      values.sentryEnableLogs === true ? { enableLogs: true } : undefined,
    transport: forwardingTransport,
    // Function form preserves SDK defaults (inboundFilters, linkedErrors,
    // nodeContext, etc.) — the array form would replace them.
    integrations: (/** @type {any[]} */ defaults) => [
      ...defaults,
      Sentry.consoleIntegration(),
    ],
    initialScope: {
      tags: { proc: "fgs", layer: "node" },
    },
  });

  // Strip the platform-context fields that `nodeContextIntegration`
  // pre-populates from `os.platform()` / `os.release()` / `os.arch()`
  // / `os.totalmem()`. On mobile those expose the kernel version and
  // a sparse device view that would otherwise *block* sentry-android's
  // `DefaultAndroidEventProcessor` / sentry-cocoa's `DefaultEventProcessor`
  // from filling in the proper user-facing values at capture time —
  // those processors respect existing data and skip on a non-null
  // object. `culture` is also dropped (Node ships an empty object).
  //
  // `contexts.app` is left alone — its fields are merged key-by-key
  // by the native processor, so Node's `app_start_time` survives
  // alongside the native-supplied identifier/version/permissions.
  // `contexts.runtime` is also kept (Node-specific; native has no
  // equivalent).
  Sentry.addEventProcessor((/** @type {any} */ event) => {
    if (!event.contexts) return event;
    delete event.contexts.os;
    delete event.contexts.device;
    delete event.contexts.culture;
    return event;
  });

  // Stash on globalThis so index.js never names `@sentry/node`
  // statically — keeps the rollup chunk gated by this argv check.
  const rpcArgsBytesRaw = asString(values.sentryRpcArgsBytes);
  /** @type {any} */ (globalThis).__comapeoSentry = Sentry;
  /** @type {any} */ (globalThis).__comapeoSentryConfig = {
    rpcArgsBytes: rpcArgsBytesRaw ? Number(rpcArgsBytesRaw) : 0,
    captureApplicationData,
  };
  // Wired by `index.js` once the control socket is bound. Drains any
  // frames the transport buffered during boot.
  /** @type {any} */ (globalThis).__comapeoSentrySetSink = (
    /** @type {(frame: SentryFrame) => void} */ realSink,
  ) => {
    sink = realSink;
    while (preListenQueue.length > 0) {
      const frame = /** @type {SentryFrame} */ (preListenQueue.shift());
      try {
        realSink(frame);
      } catch {
        // Sink threw — drop the rest rather than retrying forever.
        break;
      }
    }
  };
}

if (Sentry && sentryTrace) {
  // Continue the FGS-side `boot.node-spawn` span so Node-side boot
  // spans (loader-init, import-index, listen-control, manager-init)
  // land as children of node-spawn — they happen during it.
  await Sentry.continueTrace(
    { sentryTrace, baggage: sentryBaggage ?? "" },
    async () => {
      // boot.loader-init: retroactive span covering loader.mjs first
      // line through here (Sentry.init done + continueTrace entered).
      // Inside continueTrace so it inherits the FGS-side trace_id
      // (otherwise it'd land on a fresh trace, hidden from the boot
      // trace view). The gap between `boot.node-spawn` start and
      // `boot.loader-init` start IS the C/C++ V8-bootstrap phase —
      // visible in the trace view as an uninstrumented region with
      // clear boundaries.
      Sentry.startInactiveSpan({
        name: "boot.loader-init",
        op: "boot",
        startTime: loaderStartDate,
      })?.end();

      // `startInactiveSpan` records `boot.import-index` without
      // making it the active span. If we used `startSpan` instead,
      // index.js's IIFE would inherit it via AsyncLocalStorage and
      // its spans (`listen-control`, `manager-init`) would parent
      // to a finished `import-index` rather than `node-spawn`.
      const importSpan = Sentry.startInactiveSpan({
        name: "boot.import-index",
        op: "boot",
      });
      try {
        await import("./index.js");
      } finally {
        importSpan?.end();
      }
    },
  );
} else {
  await import("./index.js");
}
