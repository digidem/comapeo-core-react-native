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
 */
import { activeAdapter, setOverrideAdapter } from "./sentry-internal";
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
   * Registers a global event processor that runs on every event
   * before it's sent. We use it to inject our own values into
   * `event.modules` (the bundled-backend deps that the SDK's
   * `ModulesLoader` integration can't see, plus our own version
   * label).
   */
  addEventProcessor(processor: EventProcessor): void;
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

// ── State listeners ─────────────────────────────────────────────

// Apply scope-default `proc` / `layer` tags so every event from
// this hub — including default RN-SDK captures (JS errors, ANRs,
// app-start transactions) — is filterable alongside our own
// captures, not just the ones below where we set them per-call.
//
// `comapeo.module.version` is the primary filter axis for "did
// this issue start after I bumped @comapeo/core-react-native?".
// `event.modules` carries the same value plus the bundled
// backend deps that `ModulesLoader` can't introspect (rolled
// into a single `index.mjs`), so the Modules / Discover UI has
// the full dep map.
{
  const adapter = activeAdapter();
  if (adapter) {
    adapter.setTag(SentryTags.proc, SentryTags.procMain);
    adapter.setTag(SentryTags.layer, SentryTags.layerRn);
    adapter.setTag("comapeo.module.version", COMAPEO_MODULE_VERSION_LABEL);
    adapter.addEventProcessor((event) => {
      event.modules = {
        ...event.modules,
        "@comapeo/core-react-native": COMAPEO_MODULE_VERSION_LABEL,
        ...BACKEND_MODULES,
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
