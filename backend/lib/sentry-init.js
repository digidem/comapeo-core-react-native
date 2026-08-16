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

import {
  addEventProcessor,
  applySdkMetadata,
  captureException,
  captureMessage,
  close,
  consoleIntegration,
  continueTrace,
  createStackParser,
  defineIntegration,
  eventFiltersIntegration,
  flush,
  functionToStringIntegration,
  getClient,
  getCurrentScope,
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
 * function form of `integrations`, `initialScope`, `stackParser`).
 * `transport` is narrowed to required: unlike a full Node SDK this one
 * ships no default transport, so the caller must supply the IPC
 * forwarding one. The extra member is the legacy `@sentry/node-core`
 * flag `sentry.js` still sets, which this init ignores because there is
 * no ESM loader to register in the first place.
 *
 * @typedef {import("@sentry/core").Options & {
 *   transport: NonNullable<import("@sentry/core").Options["transport"]>,
 *   registerEsmLoaderHooks?: boolean,
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
 *   captureMessage: typeof captureMessage,
 *   close: typeof close,
 *   consoleIntegration: typeof consoleIntegration,
 *   continueTrace: typeof continueTrace,
 *   flush: typeof flush,
 *   getClient: typeof getClient,
 *   metrics: typeof metrics,
 *   startInactiveSpan: typeof startInactiveSpan,
 *   startSpan: typeof startSpan,
 * }} SentrySdk
 */

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

  /** @type {import("@sentry/core").ServerRuntimeClientOptions} */
  const clientOptions = {
    ...options,
    platform: "node",
    runtime: { name: "node", version: process.version },
    stackParser: createStackParser(nodeStackLineParser()),
    integrations: getIntegrationsToSetup({
      defaultIntegrations: getDefaultIntegrations(),
      integrations: options.integrations,
    }),
  };
  // Keep `event.sdk.name` on the value node-core reported so existing
  // dashboards and alerts keep matching; the package list tells the
  // truth about what we now ship.
  applySdkMetadata(clientOptions, "node-core", ["core"]);

  if (options.initialScope) getCurrentScope().update(options.initialScope);
  initAndBind(ServerRuntimeClient, clientOptions);
}

/** @type {SentrySdk} */
const SentryCoreSdk = {
  init,
  addEventProcessor,
  captureException,
  captureMessage,
  close,
  consoleIntegration,
  continueTrace,
  flush,
  getClient,
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
