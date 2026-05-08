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

  // Merges the native-supplied `sentryContext` (set later from the
  // init control frame) onto every event. Field-level merge so
  // `nodeContextIntegration`'s `runtime.version` / `app_start_time`
  // survive while native overrides the Linux/Darwin-libnode view of
  // device/os/culture.
  /** @type {Record<string, any> | null} */
  let nativeContext = null;
  Sentry.addEventProcessor((/** @type {any} */ event) => {
    if (!nativeContext) return event;
    event.contexts ??= {};
    for (const k of ["device", "os", "app", "culture"]) {
      if (nativeContext[k]) {
        event.contexts[k] = { ...event.contexts[k], ...nativeContext[k] };
      }
    }
    if (nativeContext.tags) {
      event.tags = { ...nativeContext.tags, ...event.tags };
    }
    if (nativeContext.user) {
      event.user = { ...event.user, ...nativeContext.user };
    }
    return event;
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
  /** @type {any} */ (globalThis).__comapeoSentrySetNativeContext = (
    /** @type {Record<string, any> | null} */ ctx,
  ) => {
    nativeContext = ctx;
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
