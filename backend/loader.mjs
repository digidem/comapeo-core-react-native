// New nodejs-mobile spawn target. Native (Android NodeJSService.kt /
// iOS NodeJSService.swift) passes this file as the entry script with
// `--sentry*` argv flags derived from `SentryConfig`. Parses argv,
// conditionally inits `@sentry/node`, then dynamically imports
// `index.mjs`.
//
// `Sentry.init()` must complete before `index.mjs`'s top-level
// imports run, because OpenTelemetry's import-in-the-middle hook
// can only patch modules loaded after init. The dynamic-import
// boundary here is what makes the auto-instrumentation work.
//
// When no DSN is present the `@sentry/node` chunk is never loaded —
// rollup's code-splitting puts it behind the `await import` below
// and consumers without Sentry never pay the runtime cost.

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
  // Positionals (comapeoSocketPath, controlSocketPath,
  // privateStorageDir) flow through unchanged for index.mjs to read
  // from `process.argv`.
  allowPositionals: true,
  // `strict: false` so unknown flags (e.g. the bench branch's
  // `--device=...` if it lands later, or any future Node flag passed
  // by native) don't crash the loader.
  strict: false,
});

// Local helper: with `strict: false`, every option's parsed type
// is the union of its declared type plus the opposing primitive
// (so `string` options can land as `boolean` if a caller wrote
// `--foo` without a value). Coerce to string for our own
// arithmetic, drop anything weird.
/** @param {unknown} v */
const asString = (v) => (typeof v === "string" ? v : undefined);

const dsn = asString(values.sentryDsn);
const captureApplicationData = values.captureApplicationData === true;

if (dsn) {
  // Dynamic import keeps the rollup chunk out of the consumer's
  // runtime memory when Sentry isn't configured. The chunk still
  // ships on disk in `nodejs-project/` but is never resolved.
  const Sentry = await import("@sentry/node");
  const tracesSampleRateRaw = asString(values.sentryTracesSampleRate);
  const sampleRateRaw = asString(values.sentrySampleRate);
  Sentry.init({
    dsn,
    environment: asString(values.sentryEnvironment) ?? "production",
    release: asString(values.sentryRelease),
    sampleRate: sampleRateRaw ? Number(sampleRateRaw) : 1.0,
    // Tracing is gated on the capture-application-data toggle
    // (Phase 5). Until that lands, `captureApplicationData` is
    // always false and `tracesSampleRate` stays at 0 — RPC spans
    // are still created (Sentry tracks them locally) but nothing
    // ships to the DSN. When Phase 5 wires up the toggle, flipping
    // it on a restart starts shipping spans.
    tracesSampleRate: captureApplicationData
      ? Number(tracesSampleRateRaw ?? "0.1")
      : 0,
    _experiments:
      values.sentryEnableLogs === true ? { enableLogs: true } : undefined,
    integrations: [Sentry.consoleIntegration()],
    initialScope: {
      tags: { proc: "fgs", layer: "node" },
    },
  });

  // Stash for `index.mjs` so it doesn't need to re-parse argv.
  // Pattern-2 from plan §5.3: `index.mjs` reads from globalThis,
  // never names `@sentry/node` statically, so the rollup chunk
  // is unambiguously gated by this loader's argv check.
  const rpcArgsBytesRaw = asString(values.sentryRpcArgsBytes);
  /** @type {any} */ (globalThis).__comapeoSentry = Sentry;
  /** @type {any} */ (globalThis).__comapeoSentryConfig = {
    rpcArgsBytes: rpcArgsBytesRaw ? Number(rpcArgsBytesRaw) : 0,
    captureApplicationData,
  };
}

// Always run the app, with or without Sentry.
await import("./index.js");
