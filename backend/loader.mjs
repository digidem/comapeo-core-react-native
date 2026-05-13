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

// Bracket the dominant sub-import for a child span; other loader
// sub-steps stay implicit in the parent/child gap.
/** @type {Date | undefined} */ let importSentryNodeStartDate;
/** @type {Date | undefined} */ let importSentryNodeEndDate;

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
  importSentryNodeStartDate = new Date();
  Sentry = await import("@sentry/node");
  importSentryNodeEndDate = new Date();
  // `serializeEnvelope` isn't re-exported from `@sentry/node`'s public
  // surface — import directly from `@sentry/core` (a peer dep of
  // `@sentry/node` and an explicit dep of this package).
  const { serializeEnvelope } = await import("@sentry/core");
  const { envelopeToFrame } = await import("./lib/sentry-frame.js");

  // Custom transport: forward to native over the control socket so
  // sentry-android / sentry-cocoa's offline transport queues. See
  // `lib/sentry-frame.js` for routing.
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
  // Keep in sync with `src/sentry.ts`'s DEFAULT_TRACES_SAMPLE_RATE.
  const DEFAULT_TRACES_SAMPLE_RATE = 0.1;
  Sentry.init({
    dsn,
    environment: asString(values.sentryEnvironment) ?? "production",
    release: asString(values.sentryRelease),
    sampleRate: sampleRateRaw ? Number(sampleRateRaw) : 1.0,
    // 0 unless captureApplicationData is on.
    tracesSampleRate: captureApplicationData
      ? Number(tracesSampleRateRaw ?? DEFAULT_TRACES_SAMPLE_RATE)
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

  // Strip os/device/culture so native processors fill them at capture
  // (they skip on non-null). app/runtime stay — app merges key-by-key,
  // runtime is Node-specific.
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
  // spans (loader-init, import-index, manager-init) land on the same
  // trace as the native parent.
  await Sentry.continueTrace(
    { sentryTrace, baggage: sentryBaggage ?? "" },
    async () => {
      // Retroactive span (startTime = loader.mjs first line). The gap
      // before it on the trace is the C/C++ V8-bootstrap phase.
      //
      // Inactive + explicit `parentSpan` for both children — keeps
      // ALS at node-spawn (continueTrace's parent) during the
      // `await import("./index.js")` below, so index.js's IIFE
      // captures node-spawn (not loader-init) for `boot.manager-init`.
      // loader-init has to stay LIVE while children attach — passing
      // an already-ended span as `parentSpan` doesn't reliably parent
      // under @sentry/node's OTel backend.
      const loaderInitSpan = Sentry.startInactiveSpan({
        name: "boot.loader-init",
        op: "boot.loader-init",
        startTime: loaderStartDate,
      });

      Sentry.startInactiveSpan({
        name: "boot.loader-import-sentry-node",
        op: "boot.loader-import-sentry-node",
        startTime: importSentryNodeStartDate,
        parentSpan: loaderInitSpan,
      })?.end(importSentryNodeEndDate);

      const importSpan = Sentry.startInactiveSpan({
        name: "boot.import-index",
        op: "boot.import-index",
        parentSpan: loaderInitSpan,
      });
      try {
        await import("./index.js");
      } finally {
        importSpan?.end();
        // End loader-init AFTER import-index so the parent is still
        // live at attach time (see comment above).
        loaderInitSpan?.end();
      }
    },
  );
} else {
  await import("./index.js");
}
