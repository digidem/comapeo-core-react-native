/**
 * `@comapeo/core-react-native/sentry` sub-export.
 *
 * Importing this module attaches Sentry listeners on the
 * lifecycle `state` observer. The host app must have
 * `@sentry/react-native` installed AND have called
 * `Sentry.init(...)` for events to actually flow — without
 * either, the listeners are still attached but their captures
 * silently no-op.
 *
 * Consumers don't need to call anything explicitly. Tests can
 * inject a fake adapter via [setSentryAdapterForTests].
 *
 * The static `@sentry/react-native` import lives here, not in
 * `sentry-internal.ts`, so the main barrel doesn't transitively
 * pull the optional peer dep.
 */
import * as Sentry from "@sentry/react-native";
// `getTraceData` is not re-exported from `@sentry/react-native@7`;
// `@sentry/core` is a direct dep of RN so this is safe.
import { getTraceData as coreGetTraceData } from "@sentry/core";

import {
  activeAdapter,
  registerAdapter,
  setOverrideAdapter,
} from "./sentry-internal";
import { state } from "./ComapeoCoreModule";
import type { ComapeoErrorInfo, ComapeoState } from "./ComapeoCore.types";
import { SentryTags } from "./sentry-tags";
import {
  BACKEND_MODULES,
  COMAPEO_MODULE_VERSION_LABEL,
} from "./version";

type SentrySeverityLevel = "fatal" | "error" | "warning" | "info" | "debug";

interface SentryBreadcrumb {
  category?: string;
  type?: string;
  level?: SentrySeverityLevel;
  message?: string;
  data?: Record<string, unknown>;
  timestamp?: number;
}

interface SentryCaptureContext {
  level?: SentrySeverityLevel;
  tags?: Record<string, string | number | boolean>;
  extra?: Record<string, unknown>;
  fingerprint?: string[];
}

interface SentrySpan {
  setStatus?(status: { code: number; message?: string }): void;
}

interface SentryEvent {
  modules?: Record<string, string>;
  [key: string]: unknown;
}

type EventProcessor = (event: SentryEvent) => SentryEvent | null;

/**
 * Subset of `Scope` we need on the persistent global scope. The
 * sub-export's writes go through here — *not* the top-level
 * `Sentry.setTag` / `Sentry.setContext` helpers, which target
 * the current/isolation scope and can be replaced or forked
 * when the consumer calls `Sentry.init` after our import has
 * already run (Metro hoists ESM imports above non-import code,
 * so our scope writes land before init).
 */
interface SentryGlobalScope {
  setTag(key: string, value: string | number | boolean): void;
  setContext(name: string, context: Record<string, unknown> | null): void;
  addEventProcessor(processor: EventProcessor): void;
}

/**
 * Methods this module calls on Sentry. Hand-rolled rather than
 * `Pick<typeof import("@sentry/react-native"), …>` so importing
 * this file doesn't fail typecheck for consumers without the
 * peer dep.
 *
 * Signatures match `@sentry/react-native@^7` (which re-exports
 * `@sentry/core@^9`); the auto-detected SDK satisfies this type
 * via structural compatibility.
 */
type LogMethod = (
  message: string,
  attributes?: Record<string, unknown>,
) => void;

export interface SentryAdapter {
  captureException(
    exception: unknown,
    captureContext?: SentryCaptureContext,
  ): string;
  captureMessage(
    message: string,
    captureContext?: SentryCaptureContext | SentrySeverityLevel,
  ): string;
  addBreadcrumb(breadcrumb: SentryBreadcrumb): void;
  setTag(key: string, value: string | number | boolean): void;
  /**
   * Persistent global scope — singleton from module load, not
   * forked or replaced by `Sentry.init`. Writes here survive the
   * pre-init / post-init scope handoff.
   */
  getGlobalScope(): SentryGlobalScope;
  startSpan<T>(
    options: { name: string; op?: string; forceTransaction?: boolean },
    callback: (span: SentrySpan) => T,
  ): T;
  getActiveSpan(): SentrySpan | undefined;
  continueTrace<T>(
    headers: { sentryTrace?: string; baggage?: string },
    callback: () => T,
  ): T;
  /**
   * Distributed-tracing headers for the active or supplied span.
   * Lives on `@sentry/core`; the sub-export attaches it at
   * registration since RN@7 doesn't re-export it.
   */
  getTraceData(options?: { span?: SentrySpan }): {
    "sentry-trace"?: string;
    baggage?: string;
  };
  /**
   * Sentry structured logs. SDK no-ops every call when
   * `Sentry.init({ enableLogs: true })` wasn't set, so callers
   * don't need their own gate.
   */
  logger: {
    trace: LogMethod;
    debug: LogMethod;
    info: LogMethod;
    warn: LogMethod;
    error: LogMethod;
    fatal: LogMethod;
  };
}

/**
 * Test-only — inject a fake adapter (or `null` to fall back to
 * the auto-detected `@sentry/react-native`).
 */
export function setSentryAdapterForTests(adapter: SentryAdapter | null): void {
  setOverrideAdapter(adapter);
}

// Make the SDK visible to ComapeoCoreModule.ts's RPC tracing hook.
// `getTraceData` is attached separately — see import note above.
registerAdapter({
  ...(Sentry as unknown as Omit<SentryAdapter, "getTraceData">),
  getTraceData: coreGetTraceData as unknown as SentryAdapter["getTraceData"],
});

// ── State listeners ─────────────────────────────────────────────

// Apply scope-default `proc` / `layer` tags so every event from
// this hub — including default RN-SDK captures (JS errors, ANRs,
// app-start transactions) — is filterable alongside our own
// captures, not just the ones below where we set them per-call.
//
// `comapeo.rn` is the primary filter axis for "did this issue
// start after I bumped @comapeo/core-react-native?". The value
// is `<version>+git<sha>[-dirty<hash>]` so a single tag covers
// both release and source identity, and you can `git checkout`
// straight from a Sentry event.
//
// `event.modules` only carries `@comapeo/core-react-native`
// itself — the JS-runtime dep that actually runs in the host's
// RN bundle. The bundled-backend deps (@comapeo/core etc.) are
// in a separate `comapeoBackend` context block. Putting them
// in `event.modules` would collide with anything the consumer
// imports directly from RN-side (e.g. `@comapeo/core` for type
// or static exports may be a different version than the one
// rolled into our backend bundle).
//
// We target the **global scope** rather than the top-level
// `setTag` / `setContext` / `addEventProcessor` helpers. The
// latter write to the current/isolation scope, which the
// consumer's `Sentry.init` may fork or replace — and Metro's
// import hoisting (and `inlineRequires: true`) means this
// side-effect import runs BEFORE the consumer's init call even
// when `import "@comapeo/core-react-native/sentry"` appears
// below `Sentry.init({...})` in source. The global scope is a
// persistent module-level singleton; writes here survive init.
{
  const adapter = activeAdapter();
  if (adapter) {
    const globalScope = adapter.getGlobalScope();
    globalScope.setTag(SentryTags.proc, SentryTags.procMain);
    globalScope.setTag(SentryTags.layer, SentryTags.layerRn);
    globalScope.setTag("comapeo.rn", COMAPEO_MODULE_VERSION_LABEL);
    globalScope.setContext("comapeoBackend", BACKEND_MODULES);
    globalScope.addEventProcessor((event) => {
      event.modules = {
        ...event.modules,
        "@comapeo/core-react-native": COMAPEO_MODULE_VERSION_LABEL,
      };
      return event;
    });
  }
}

state.addListener("stateChange", handleStateChange);
state.addListener("messageerror", handleMessageError);

function handleStateChange(s: ComapeoState, info: ComapeoErrorInfo | null) {
  const adapter = activeAdapter();
  if (!adapter) return;

  const data = info
    ? {
        state: s,
        errorPhase: info.errorPhase,
        errorMessage: info.errorMessage,
      }
    : { state: s };
  adapter.addBreadcrumb({
    category: "comapeo.state",
    type: "state",
    level: s === "ERROR" ? "error" : "info",
    message: `comapeo state → ${s}`,
    data,
  });
  const logFn = s === "ERROR" ? adapter.logger.error : adapter.logger.info;
  logFn(`comapeo state → ${s}`, data);

  // Synthesised Error name encodes the phase so Sentry's grouping
  // treats e.g. rootkey vs. starting-timeout as distinct issues
  // without us maintaining a fingerprint table.
  if (s === "ERROR" && info) {
    const e = new Error(info.errorMessage);
    e.name = `ComapeoError:${info.errorPhase}`;
    adapter.captureException(e, {
      tags: {
        [SentryTags.layer]: SentryTags.layerRn,
        [SentryTags.proc]: SentryTags.procMain,
        [SentryTags.phase]: info.errorPhase,
        [SentryTags.state]: s,
      },
    });
  }
}

function handleMessageError(err: Error) {
  const adapter = activeAdapter();
  if (!adapter) return;

  // Truncate before forwarding — the wrapped message echoes the
  // raw control frame, which can include arbitrary bytes from a
  // corrupted parse. 256 chars retains the readable prefix.
  const truncated = truncateForSentry(err.message);
  const wrapped = new Error(truncated);
  wrapped.name = err.name;
  adapter.captureException(wrapped, {
    tags: {
      [SentryTags.layer]: SentryTags.layerRn,
      [SentryTags.proc]: SentryTags.procMain,
      [SentryTags.source]: "control-socket",
    },
    level: "warning",
  });
  adapter.logger.warn(truncated, {
    [SentryTags.source]: "control-socket",
    "exception.name": err.name,
  });
}

const MESSAGE_ERROR_MAX_LEN = 256;

function truncateForSentry(input: string): string {
  if (input.length <= MESSAGE_ERROR_MAX_LEN) return input;
  return `${input.slice(0, MESSAGE_ERROR_MAX_LEN)}… [truncated ${input.length - MESSAGE_ERROR_MAX_LEN} chars]`;
}
