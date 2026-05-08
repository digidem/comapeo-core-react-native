// nodejs-mobile spawn target. `Sentry.init()` must run before
// `index.js`'s static imports so OpenTelemetry's import-in-the-middle
// hook can patch them.

import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    sentryDsn: { type: "string" },
    sentryEnvironment: { type: "string" },
    sentryRelease: { type: "string" },
    sentrySampleRate: { type: "string" },
    sentryTracesSampleRate: { type: "string" },
    sentryRpcArgsBytes: { type: "string" },
    sentryEnableLogs: { type: "boolean" },
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

if (dsn) {
  // Dynamic import keeps the rollup chunk unloaded when Sentry is off.
  const Sentry = await import("@sentry/node");
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
    integrations: (defaults) => [...defaults, Sentry.consoleIntegration()],
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
  Sentry.addEventProcessor((event) => {
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

await import("./index.js");
