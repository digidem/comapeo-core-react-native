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

// Checkpoints bracketing `import("@sentry/node")` — emitted as a single
// `boot.loader-import-sentry-node` child of `boot.loader-init` once
// continueTrace runs below. That import is the dominant chunk of
// loader-init; the other sub-steps (parseArgs, iitm register, smaller
// imports, Sentry.init) collectively stay <200ms on the reference
// device and aren't worth their own spans. The gap between
// loader-init's duration and the child's duration captures them
// implicitly if they ever regress.
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
  // spans (loader-init, import-index, manager-init) land on the same
  // trace as the native parent.
  await Sentry.continueTrace(
    { sentryTrace, baggage: sentryBaggage ?? "" },
    async () => {
      // boot.loader-init: retroactive span covering loader.mjs first
      // line through here (Sentry.init done + continueTrace entered).
      // Inside continueTrace so it inherits the FGS-side trace_id —
      // otherwise it'd land on a fresh trace, hidden from the boot
      // trace view. The gap between `boot.node-spawn` start and
      // `boot.loader-init` start IS the C/C++ V8-bootstrap phase —
      // visible in the trace view as an uninstrumented region with
      // clear boundaries.
      //
      // `startSpan` (not `startInactiveSpan`) so the sync callback runs
      // with loader-init as the active span — the import-sentry-node
      // child parents to it via AsyncLocalStorage. Callback is
      // synchronous, so the active-span context is restored before the
      // `await import("./index.js")` below — that has to happen with
      // node-spawn (continueTrace's parent) as the active span so
      // index.js's IIFE captures node-spawn as the parent for its
      // `boot.manager-init` span, not loader-init.
      const loaderInitSpan = Sentry.startSpan(
        {
          name: "boot.loader-init",
          op: "boot.loader-init",
          startTime: loaderStartDate,
        },
        (/** @type {any} */ span) => {
          Sentry.startInactiveSpan({
            name: "boot.loader-import-sentry-node",
            op: "boot.loader-import-sentry-node",
            startTime: importSentryNodeStartDate,
          })?.end(importSentryNodeEndDate);
          // Return the handle so we can attach `import-index` as a
          // child of loader-init without re-entering its active scope.
          return span;
        },
      );

      // `boot.import-index` is a logical sub-step of loader-init (the
      // loader's other job is to dynamic-import index.js), so it
      // parents to loader-init via the explicit `parentSpan` option
      // rather than via AsyncLocalStorage. Using `startInactiveSpan`
      // + explicit parent leaves the active-span context untouched —
      // index.js's IIFE then captures node-spawn for its
      // `boot.manager-init` span. The order matters: loader-init's
      // duration ends before this span starts (sync callback already
      // returned), so import-index appears as a child whose timing is
      // outside its parent's timing — Sentry renders this fine.
      const importSpan = Sentry.startInactiveSpan({
        name: "boot.import-index",
        op: "boot.import-index",
        parentSpan: loaderInitSpan,
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
