// Heavy-import staging file. Every dep that we want held out of the
// always-on chunk lives here: `@sentry/core` and `sentry-frame.js`
// (which pulls in `@sentry/core`'s envelope serializer). `loader.mjs`
// reaches us via a gated dynamic `import("./lib/sentry-init.js")` so
// none of this loads when `--sentryDsn` is absent.
//
// This file also *is* the SDK: rather than depending on a prebuilt Node
// SDK, it assembles a minimal client out of `@sentry/core` primitives —
// the same shape `@sentry/deno` and `@sentry/vercel-edge` use. That
// replaces the previous `@sentry/node-core` + `@sentry/opentelemetry` +
// OpenTelemetry SDK stack, which cost ~357 KB of the built chunk (and
// the matching parse/eval + heap on every FGS boot) to provide a
// tracing backend and a set of default integrations we had configured
// into a no-op: no auto-instrumentations were ever registered, the HTTP
// transport is replaced by `sentry.js`'s IPC forwarding transport, and
// fatals go through `index.js`'s own `handleFatal` handlers. See
// `docs/sentry-core-migration-plan.md` for the full accounting.
//
// The external contract is unchanged: `initSentry(argv, storageDir)`,
// injecting an SDK namespace into `sentry.js`, which owns all the
// policy (DSN/sampling/scrubbing/transport wiring).

import { dirname, posix } from "node:path";

import {
  addEventProcessor,
  applySdkMetadata,
  captureException,
  consoleIntegration,
  continueTrace,
  createStackParser,
  defineIntegration,
  eventFiltersIntegration,
  flush,
  functionToStringIntegration,
  getIntegrationsToSetup,
  initAndBind,
  linkedErrorsIntegration,
  metrics,
  nodeStackLineParser,
  ServerRuntimeClient,
  startInactiveSpan,
  startSpan,
} from "@sentry/core";

import { setAlsAsyncContextStrategy } from "./als-async-context.js";
import { envelopeToFrame } from "./sentry-frame.js";
import * as sentry from "./sentry.js";

/** @typedef {import("./sentry.js").Argv} Argv */

/**
 * Options our `init` accepts. `@sentry/core`'s `Options` is the
 * user-facing bag and already covers everything `sentry.js` passes (the
 * function form of `integrations`, `initialScope`). `transport` is
 * narrowed to required: unlike a full Node SDK this one ships no
 * default transport, so the caller must supply the IPC forwarding one.
 * `stackParser` is inherited from `Options` but ignored — `init`
 * always installs the Node one below.
 *
 * @typedef {import("@sentry/core").Options & {
 *   transport: NonNullable<import("@sentry/core").Options["transport"]>,
 * }} SentryInitOptions
 */

/**
 * The SDK surface `sentry.js` and `metrics.js` consume. Injected rather
 * than imported by them so the chunk this file lives in stays unloaded
 * when Sentry is off.
 *
 * @typedef {{
 *   init: (options: SentryInitOptions) => void,
 *   addEventProcessor: typeof addEventProcessor,
 *   captureException: typeof captureException,
 *   consoleIntegration: typeof consoleIntegration,
 *   continueTrace: typeof continueTrace,
 *   flush: typeof flush,
 *   metrics: typeof metrics,
 *   startInactiveSpan: typeof startInactiveSpan,
 *   startSpan: typeof startSpan,
 * }} SentrySdk
 */

/**
 * Recreates `@sentry/node-core`'s `createGetModuleFromFilename`, which
 * `@sentry/core` does not export. It feeds `nodeStackLineParser` the
 * `module` attribute on every stack frame — load-bearing because
 * Sentry's default grouping fingerprints on module+function, so
 * dropping it would re-fingerprint every existing backend issue.
 *
 * Only node-core's live branch is kept. Its `/node_modules/` branch is
 * dead here (the rolled-up bundle ships no runtime JS under
 * `node_modules` — only json/sql/smp data files) and so is its Windows
 * path handling (nodejs-mobile runs on Android and iOS only).
 *
 * @param {string} basePath
 * @returns {(filename: string | undefined) => string | undefined}
 */
function createGetModuleFromFilename(basePath) {
  return (filename) => {
    if (!filename) return undefined;
    const { dir, base, ext } = posix.parse(filename);
    const file =
      ext === ".js" || ext === ".mjs" || ext === ".cjs"
        ? base.slice(0, -ext.length)
        : base;
    const decodedFile = decodeURIComponent(file);
    if (!dir || !dir.startsWith(basePath)) return decodedFile;
    const moduleName = dir.slice(basePath.length + 1).replace(/\//g, ".");
    return moduleName ? `${moduleName}:${decodedFile}` : decodedFile;
  };
}

/**
 * `@sentry/core` accumulates discarded-event outcomes (events dropped
 * by `scrubEvent`, by sampling, by rate limits) but — unlike the
 * browser and node clients — never emits them: `_flushOutcomes` exists
 * on `Client` and nothing in core calls it. Subclassing is how the
 * upstream SDKs reach that protected method, so we do the same and
 * hang it off the public `flush` hook.
 *
 * That covers `close()` too (it flushes first) and, more importantly,
 * the shutdown path already calls `sentry.flush()`. We deliberately
 * skip node-core's other trigger — a 60s `setInterval` — because a
 * perpetual timer in a foreground service tuned for low-memory devices
 * is a poor trade for a report that is only read in aggregate.
 */
class ClientReportingClient extends ServerRuntimeClient {
  /** @param {import("@sentry/core").ServerRuntimeClientOptions} options */
  constructor(options) {
    super(options);
    this.on("flush", () => {
      this._flushOutcomes();
    });
  }
}

/**
 * The one piece of `@sentry/node-core`'s `nodeContextIntegration` worth
 * keeping. We delete `os`/`device`/`culture` in `sentry.js` (the native
 * SDKs fill those at capture time) and `runtime` comes from
 * `ServerRuntimeClient`'s `runtime` option, but nothing else supplies
 * `contexts.app`. Start time is fixed for the process; RSS is re-read
 * per event, matching node-core's behaviour.
 */
const appContextIntegration = defineIntegration(() => {
  const appStartTime = new Date(Date.now() - process.uptime() * 1000).toISOString();
  return {
    name: "AppContext",
    processEvent(event) {
      event.contexts = {
        ...event.contexts,
        app: {
          app_start_time: appStartTime,
          app_memory: process.memoryUsage().rss,
          ...event.contexts?.app,
        },
      };
      return event;
    },
  };
});

/**
 * The default integrations we keep from `@sentry/node-core`'s list —
 * the pure-JS core ones. The node-specific ones (`http`,
 * `nativeNodeFetch`, `contextLines`, `localVariables`, `modules`,
 * `nodeContext`, `childProcess`, `processSession`, `onUncaughtException`,
 * `onUnhandledRejection`) are either irrelevant in the FGS, replaced by
 * native-side context, or already covered by `index.js`'s own
 * `handleFatal` handlers. See the behaviour-deltas table in
 * `docs/sentry-core-migration-plan.md`.
 *
 * @returns {import("@sentry/core").Integration[]}
 */
function getDefaultIntegrations() {
  return [
    eventFiltersIntegration(),
    functionToStringIntegration(),
    linkedErrorsIntegration(),
    appContextIntegration(),
  ];
}

/**
 * Minimal `Sentry.init` built on `@sentry/core` primitives.
 *
 * @param {SentryInitOptions} options
 */
function init(options) {
  // Must precede `initAndBind`: `@sentry/core`'s default strategy is a
  // synchronous stack that loses scope across `await`, and `sentry.js`
  // spans all straddle async boundaries.
  setAlsAsyncContextStrategy();

  // `process.argv[1]` is the loader inside `nodejs-project/`, so this
  // resolves to the bundle root and frames come out as `index`,
  // `loader`, `chunks:sentry-init-<hash>` — the same shape node-core
  // produced, which is what keeps issue fingerprints stable.
  const basePath = process.argv[1] ? dirname(process.argv[1]) : process.cwd();

  /** @type {import("@sentry/core").ServerRuntimeClientOptions} */
  const clientOptions = {
    // Core leaves this undefined, which silently disables
    // `recordDroppedEvent`; node-core defaulted it on. Overridable.
    sendClientReports: true,
    ...options,
    platform: "node",
    runtime: { name: "node", version: process.version },
    stackParser: createStackParser(
      nodeStackLineParser(createGetModuleFromFilename(basePath)),
    ),
    integrations: getIntegrationsToSetup({
      defaultIntegrations: getDefaultIntegrations(),
      integrations: options.integrations,
    }),
  };
  // Keep `event.sdk.name` on the value node-core reported so existing
  // dashboards and alerts keep matching; the package list tells the
  // truth about what we now ship.
  applySdkMetadata(clientOptions, "node-core", ["core"]);

  // `initAndBind` applies `initialScope` to the current scope itself.
  initAndBind(ClientReportingClient, clientOptions);
}

// Exactly what `sentry.js` / `metrics.js` call — nothing speculative.
// Anything they grow a need for gets added here alongside the call.
/** @type {SentrySdk} */
const SentryCoreSdk = {
  init,
  addEventProcessor,
  captureException,
  consoleIntegration,
  continueTrace,
  flush,
  metrics,
  startInactiveSpan,
  startSpan,
};

/**
 * Builds and installs the Sentry SDK from a single `loader.mjs`
 * callsite. Caller has already verified `argv.sentryDsn` is set.
 * Returns once everything is registered so the loader's
 * `boot.loader-import-sentry-node` span brackets both the chunk import
 * AND the SDK init.
 *
 * @param {Argv} argv
 * @param {string} [storageDir] private-storage positional, for
 *   capture-time free-disk reads (usage tier).
 */
export function initSentry(argv, storageDir) {
  sentry.init({ Sentry: SentryCoreSdk, argv, envelopeToFrame, storageDir });
}
