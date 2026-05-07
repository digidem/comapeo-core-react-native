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

/**
 * Methods this module calls on Sentry. Hand-rolled rather than
 * `Pick<typeof import("@sentry/react-native"), …>` so importing
 * this file doesn't fail typecheck for consumers without the
 * peer dep.
 *
 * The signatures match `@sentry/react-native@^6` (which
 * re-exports `@sentry/core@^8`); the auto-detected SDK
 * satisfies this type via structural compatibility.
 */
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
  startSpan<T>(
    options: { name: string; op?: string; forceTransaction?: boolean },
    callback: (span: SentrySpan) => T,
  ): T;
  getActiveSpan(): SentrySpan | undefined;
  continueTrace<T>(
    headers: { sentryTrace?: string; baggage?: string },
    callback: () => T,
  ): T;
}

/**
 * Test-only — inject a fake adapter (or `null` to fall back to
 * the auto-detected `@sentry/react-native`).
 */
export function setSentryAdapterForTests(adapter: SentryAdapter | null): void {
  setOverrideAdapter(adapter);
}

// ── State listeners ─────────────────────────────────────────────

state.addListener("stateChange", handleStateChange);
state.addListener("messageerror", handleMessageError);

function handleStateChange(s: ComapeoState, info: ComapeoErrorInfo | null) {
  const adapter = activeAdapter();
  if (!adapter) return;

  adapter.addBreadcrumb({
    category: "comapeo.state",
    type: "state",
    level: s === "ERROR" ? "error" : "info",
    message: `comapeo state → ${s}`,
    data: info
      ? {
          state: s,
          errorPhase: info.errorPhase,
          errorMessage: info.errorMessage,
        }
      : { state: s },
  });

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
}

const MESSAGE_ERROR_MAX_LEN = 256;

function truncateForSentry(input: string): string {
  if (input.length <= MESSAGE_ERROR_MAX_LEN) return input;
  return `${input.slice(0, MESSAGE_ERROR_MAX_LEN)}… [truncated ${input.length - MESSAGE_ERROR_MAX_LEN} chars]`;
}
