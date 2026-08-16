// nodejs-mobile spawn target. The Sentry SDK init must run before
// `index.js`'s static imports so the client and the async-context
// strategy are installed before any code starts producing spans
// through `sentry.js`'s wrappers.

import { parseArgs } from "node:util";
import * as sentry from "./lib/sentry.js";

// Captured at first line so `boot.loader-init` covers everything from
// process spawn through Sentry.init.
const loaderStartDate = new Date();

const { values, positionals } = parseArgs({
  options: sentry.argSpec,
  allowPositionals: true,
});

// Bracket the dominant sub-import for a child span; other loader
// sub-steps stay implicit in the parent/child gap.
/** @type {Date | undefined} */ let importSentryNodeStartDate;
/** @type {Date | undefined} */ let importSentryNodeEndDate;

if (values.sentryDsn) {
  // `sentry-init.js` is the staging file that aggregates every heavy
  // dependency we hold out of the always-on chunk — `@sentry/core`
  // (from which it assembles the SDK itself) and `sentry-frame.js`.
  // Dynamic import keeps the rollup chunk unloaded when no DSN is
  // configured; the span around it measures the full SDK load+init.
  //
  // We do NOT register `import-in-the-middle` here. Nothing is
  // auto-instrumented — RPC and boot spans are all created by hand in
  // `sentry.js` — so the iitm loader thread would have nothing to hook
  // and is pure dead weight.
  importSentryNodeStartDate = new Date();
  const { initSentry } = await import("./lib/sentry-init.js");
  // 3rd positional is privateStorageDir (see index.js) — used for
  // capture-time free-disk reads at the usage tier.
  initSentry(values, positionals[2]);
  importSentryNodeEndDate = new Date();
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
