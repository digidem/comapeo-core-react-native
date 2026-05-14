// nodejs-mobile spawn target. `Sentry.init()` must run before
// `index.js`'s static imports so OpenTelemetry's import-in-the-middle
// hook can patch them.

// Local name `register` (not aliased) so `rollup-plugin-import-hook.mjs`'s
// `register('import-in-the-middle/hook.mjs', ...)` regex matches.
import { register } from "node:module";
import { parseArgs } from "node:util";
import { setupSentry, forwardingTransport } from "./lib/sentry-instrument.js";

// Captured at first line so `boot.loader-init` covers everything from
// process spawn through Sentry.init.
const loaderStartDate = new Date();

const {
  values: {
    sentryDsn,
    sentryEnvironment,
    sentryRelease,
    sentrySampleRate,
    sentryTracesSampleRate,
    sentryRpcArgsBytes,
    sentryEnableLogs,
    sentryTrace,
    sentryBaggage,
    captureApplicationData,
  },
} = parseArgs({
  options: {
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
  },
  allowPositionals: true,
});

/**
 * Coerce a numeric CLI arg, throwing if native passed a non-finite
 * value. Loud-fail symmetric with `strict: true`.
 *
 * @param {string | number} raw
 */
const numericArg = (raw) => {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`Expected numeric arg, got ${JSON.stringify(raw)}`);
  }
  return n;
};

/** @type {import("@sentry/node") | undefined} */
let Sentry;

// Bracket the dominant sub-import for a child span; other loader
// sub-steps stay implicit in the parent/child gap.
/** @type {Date | undefined} */ let importSentryNodeStartDate;
/** @type {Date | undefined} */ let importSentryNodeEndDate;

if (sentryDsn) {
  // Register iitm hook BEFORE importing @sentry/node so OTel
  // auto-instrumentations registered during init can patch modules
  // we import after. `@sentry/node@8`'s own `maybeInitializeEsmLoader`
  // is gated on `typeof require === 'undefined'`, which `esm-shim`'s
  // `createRequire` injection makes always-truthy in our bundle —
  // the SDK's call is dead code, so we have to register ourselves.
  // The string is rewritten to `'./importHook.js'` by
  // `rollup-plugin-import-hook.mjs` so it lands on the bundled hook.
  register("import-in-the-middle/hook.mjs", import.meta.url);

  // Dynamic import keeps the rollup chunk unloaded when no DSN is
  // configured.
  importSentryNodeStartDate = new Date();
  Sentry = await import("@sentry/node");
  importSentryNodeEndDate = new Date();
  const { envelopeToFrame } = await import("./lib/sentry-frame.js");

  // Forwarding transport routes envelopes to the control socket so
  // sentry-{android,cocoa}'s offline transport queues. setupSentry
  // before init so the transport's first fire finds the singletons.
  setupSentry({
    Sentry,
    config: {
      rpcArgsBytes: numericArg(sentryRpcArgsBytes),
      captureApplicationData,
    },
    envelopeToFrame,
  });

  // Keep in sync with `src/sentry.ts`'s DEFAULT_TRACES_SAMPLE_RATE.
  const DEFAULT_TRACES_SAMPLE_RATE = 0.1;
  Sentry.init({
    dsn: sentryDsn,
    environment: sentryEnvironment,
    release: sentryRelease,
    sampleRate: numericArg(sentrySampleRate),
    tracesSampleRate: captureApplicationData
      ? numericArg(sentryTracesSampleRate ?? DEFAULT_TRACES_SAMPLE_RATE)
      : 0,
    _experiments: sentryEnableLogs ? { enableLogs: true } : undefined,
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

if (Sentry && sentryTrace) {
  // Continue the FGS-side `boot.node-spawn` span so Node-side boot
  // spans land on the same trace as the native parent.
  await Sentry.continueTrace(
    { sentryTrace, baggage: sentryBaggage },
    async () => {
      // Inactive + explicit `parentSpan` for both children: keeps ALS
      // at node-spawn during the `await import("./index.js")`, so
      // index.js's IIFE captures node-spawn (not loader-init) for
      // `boot.manager-init`. loader-init must stay LIVE while children
      // attach — passing an already-ended span as `parentSpan` doesn't
      // reliably parent under @sentry/node's OTel backend.
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
        loaderInitSpan?.end();
      }
    },
  );
} else {
  await import("./index.js");
}
