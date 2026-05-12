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

  // Forward every captured payload to the native side via the control
  // socket instead of HTTP. `sentry-android` / `sentry-cocoa` already
  // run in the host process with offline-capable transports; piping
  // our payloads through them means we inherit their connectivity-aware
  // queueing, retry, and rate-limit handling — `@sentry/node` has no
  // equivalent and the device is offline for long stretches.
  //
  // Two wire shapes:
  //   - `{type:"sentry-event", payload:<event JSON>}` for a single
  //     error-event envelope item. Native deserializes via
  //     `SentryEventDecoder` / `SentryEvent.Deserializer` and captures
  //     via `SentrySDK.capture(event:)` / `Sentry.captureEvent(...)`,
  //     so native scope (device, OS, app, user, native breadcrumbs)
  //     merges at capture time and Node doesn't have to carry it.
  //   - `{type:"sentry-envelope", data:<base64>}` for everything else
  //     (transactions, sessions, check-ins, profiles, attachments,
  //     multi-item envelopes). Native hands the raw bytes to its
  //     hybrid envelope-capture entrypoint — no scope merge, but
  //     transactions don't need it (the parent transaction is opened
  //     natively and Node spans inherit its scope via `continueTrace`).
  //
  // `index.js` registers the real sink via `__comapeoSentrySetSink`
  // after the control socket binds. Frames emitted before then sit in
  // a bounded ring buffer so events captured during boot — e.g. a
  // throw inside an addon's top-level `require` — aren't lost.
  /** @typedef {{type: "sentry-event", payload: any} | {type: "sentry-envelope", data: string}} SentryFrame */
  /** @type {((frame: SentryFrame) => void) | null} */
  let sink = null;
  const PRE_LISTEN_QUEUE_MAX = 100;
  /** @type {SentryFrame[]} */
  const preListenQueue = [];

  /** @param {any} envelope */
  function envelopeToFrame(envelope) {
    // `Envelope` is `[header, items]`; each item is `[itemHeader, payload]`.
    // The only shape that benefits from the event path is a single-item
    // envelope whose item is an error-event payload. Anything else
    // (transactions, attachments alongside an event, sessions, check-ins)
    // rides the envelope path so nothing is dropped.
    const items = envelope[1];
    if (Array.isArray(items) && items.length === 1) {
      const [itemHeader, payload] = items[0];
      if (itemHeader && itemHeader.type === "event") {
        return /** @type {SentryFrame} */ ({
          type: "sentry-event",
          payload,
        });
      }
    }
    const serialized = serializeEnvelope(envelope);
    const bytes =
      typeof serialized === "string"
        ? Buffer.from(serialized, "utf-8")
        : Buffer.from(serialized);
    return /** @type {SentryFrame} */ ({
      type: "sentry-envelope",
      data: bytes.toString("base64"),
    });
  }

  const forwardingTransport = () => ({
    /** @param {any} envelope */
    send: async (envelope) => {
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

  // boot.loader-init (stage C, part 1): retroactive span covering
  // everything from `loader.mjs` first line through `Sentry.init`.
  // Recorded after init because we don't have a tracer until then.
  const loaderInitSpan = Sentry.startInactiveSpan({
    name: "boot.loader-init",
    op: "boot",
    startTime: loaderStartDate,
  });
  loaderInitSpan?.end();

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
  // spans (loader-init, import-index, listen-control) land as
  // children of node-spawn — they happen during it.
  await Sentry.continueTrace(
    { sentryTrace, baggage: sentryBaggage ?? "" },
    async () => {
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
