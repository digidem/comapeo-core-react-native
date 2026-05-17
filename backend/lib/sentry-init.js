// Heavy-import staging file. Every dep that we want held out of the
// always-on chunk lives here: `@sentry/node-core`, `@sentry/opentelemetry`,
// the OpenTelemetry SDK, and `sentry-frame.js` (which pulls in
// `@sentry/core`'s envelope serializer). `loader.mjs` reaches us via a
// gated dynamic `import("./lib/sentry-init.js")` so none of this loads
// when `--sentryDsn` is absent.
//
// The Sentry Node SDK has been split as of v10 into `@sentry/node-core`
// (slim, BYO instrumentations) and `@sentry/node` (full, ~24 OTel
// auto-instrumentation packages). We use node-core and wire OTel by
// hand — no auto-instrumentations are registered because the FGS has
// no incoming HTTP server worth tracing automatically and our manual
// RPC span (see `sentry.js`'s `rpcHook`) covers what the dashboard
// actually needs.

import { context, propagation, trace } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import * as Sentry from "@sentry/node-core";
import {
  SentryPropagator,
  SentrySampler,
  SentrySpanProcessor,
} from "@sentry/opentelemetry";

import { envelopeToFrame } from "./sentry-frame.js";
import * as sentry from "./sentry.js";

/** @typedef {import("./sentry.js").Argv} Argv */

/**
 * Wires `@sentry/node-core` + the OpenTelemetry SDK from a single
 * `loader.mjs` callsite. Caller has already verified `argv.sentryDsn`
 * is set. Returns once everything is registered so the loader's
 * `boot.loader-import-sentry-node` span brackets both the chunk
 * import AND the SDK init.
 *
 * @param {Argv} argv
 */
export function initSentry(argv) {
  sentry.init({ Sentry, argv, envelopeToFrame });

  const client = Sentry.getClient();
  if (!client) return;

  // Canonical node-core wiring per
  // https://github.com/getsentry/sentry-javascript/blob/develop/packages/node-core/README.md
  // — register no instrumentations. RPC spans come from `rpcHook` in
  // `sentry.js`; boot spans come from `withBootTrace`. Nothing else
  // in the FGS warrants auto-instrumentation.
  const provider = new NodeTracerProvider({
    sampler: new SentrySampler(client),
    spanProcessors: [new SentrySpanProcessor()],
  });
  trace.setGlobalTracerProvider(provider);
  propagation.setGlobalPropagator(new SentryPropagator());
  context.setGlobalContextManager(new Sentry.SentryContextManager());

  Sentry.setupOpenTelemetryLogger();
  Sentry.validateOpenTelemetrySetup();
}
