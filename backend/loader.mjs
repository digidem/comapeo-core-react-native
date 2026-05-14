// nodejs-mobile spawn target. `Sentry.init()` must run before
// `index.js`'s static imports so OpenTelemetry's import-in-the-middle
// hook can patch them.

// Local name `register` (not aliased) so `rollup-plugin-import-hook.mjs`'s
// `register('import-in-the-middle/hook.mjs', ...)` regex matches.
import { register } from "node:module";
import { parseArgs } from "node:util";
import * as sentry from "./lib/sentry.js";

// Captured at first line so `boot.loader-init` covers everything from
// process spawn through Sentry.init.
const loaderStartDate = new Date();

const { values } = parseArgs({
  options: sentry.argSpec,
  allowPositionals: true,
});

// Bracket the dominant sub-import for a child span; other loader
// sub-steps stay implicit in the parent/child gap.
/** @type {Date | undefined} */ let importSentryNodeStartDate;
/** @type {Date | undefined} */ let importSentryNodeEndDate;

if (values.sentryDsn) {
  // iitm must register BEFORE @sentry/node loads — the SDK's own
  // `maybeInitializeEsmLoader` is dead code in our esm-shim'd bundle
  // (gated on `typeof require === 'undefined'`, which createRequire
  // injection makes always-truthy). The literal string is rewritten
  // to `'./importHook.js'` by `rollup-plugin-import-hook.mjs`.
  register("import-in-the-middle/hook.mjs", import.meta.url);

  // Dynamic import keeps the rollup chunk unloaded when no DSN is
  // configured.
  importSentryNodeStartDate = new Date();
  const Sentry = await import("@sentry/node");
  importSentryNodeEndDate = new Date();
  const { envelopeToFrame } = await import("./lib/sentry-frame.js");

  sentry.init({ Sentry, argv: values, envelopeToFrame });
}

await sentry.withBootTrace(
  {
    argv: values,
    loaderStartDate,
    importSentryNodeStartDate,
    importSentryNodeEndDate,
  },
  () => import("./index.js"),
);
