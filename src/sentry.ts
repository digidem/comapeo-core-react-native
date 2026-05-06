/**
 * Phase 1 of the Sentry integration (see docs/sentry-integration-plan.md):
 * a small JS-side adapter handoff so this module can capture the errors it
 * already surfaces via `state` into the host app's already-initialized
 * `@sentry/react-native`. This file is the only public Sentry surface and
 * is reachable as the `@comapeo/core-react-native/sentry` sub-export.
 *
 * Imports of this file should never trigger the Sentry SDK to load. The
 * SentryAdapter interface is hand-rolled rather than picked from
 * `@sentry/react-native`'s type tree so consumers that don't install the
 * (optional) peer dep don't get a typecheck error.
 */
import { activeAdapter, setActiveAdapter } from "./sentry-internal";
import { state } from "./ComapeoCoreModule";
import type { ComapeoErrorInfo, ComapeoState } from "./ComapeoCore.types";

/**
 * Sentry severity levels we use. Subset of `@sentry/types`'
 * `SeverityLevel` — listed by hand so this file has no compile-time
 * dependency on a Sentry package being installed.
 */
type SentrySeverityLevel = "fatal" | "error" | "warning" | "info" | "debug";

/**
 * Subset of Sentry's `Breadcrumb` shape we use. Plain object literal at
 * the call site, not a class — accepted by both `@sentry/react-native`
 * and `@sentry/node`.
 */
interface SentryBreadcrumb {
  category?: string;
  type?: string;
  level?: SentrySeverityLevel;
  message?: string;
  data?: Record<string, unknown>;
  timestamp?: number;
}

/**
 * Subset of Sentry's `ScopeContext` we pass as the `captureContext`
 * second argument to `captureException` / `captureMessage`. Sentry v8
 * accepts this shorthand in place of an `EventHint`.
 */
interface SentryCaptureContext {
  level?: SentrySeverityLevel;
  tags?: Record<string, string | number | boolean>;
  extra?: Record<string, unknown>;
  fingerprint?: string[];
}

/**
 * Opaque span/transaction handle returned by `startSpan`. Treated as
 * unknown by this module — Phase 3 (RPC client tracing) will use the
 * span via `getTraceData({ span })` from `@sentry/core`, not via this
 * type.
 */
interface SentrySpan {
  setStatus?(status: { code: number; message?: string }): void;
}

/**
 * The methods this module calls on Sentry. Hand-rolled rather than
 * `Pick<typeof import("@sentry/react-native"), ...>` so:
 *
 * 1. Consumers who don't install the optional `@sentry/react-native`
 *    peer dep don't get a typecheck error from importing this module.
 * 2. The contract is explicit: changes to Sentry's type tree don't
 *    silently widen our coupling.
 *
 * The signatures match `@sentry/react-native@^6` (which re-exports
 * `@sentry/core@^8`) — passing `Sentry` directly satisfies this type
 * via structural compatibility.
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
  /**
   * Phase 3 (RPC client tracing) will read this. Phase 1 doesn't call
   * it but the type is part of the contract so consumers see the full
   * set up-front.
   */
  startSpan<T>(
    options: { name: string; op?: string; forceTransaction?: boolean },
    callback: (span: SentrySpan) => T,
  ): T;
  getActiveSpan(): SentrySpan | undefined;
  /**
   * Phase 3: continues a trace from incoming `sentry-trace` / `baggage`
   * headers. Listed for forward-compat; not called in Phase 1.
   */
  continueTrace<T>(
    headers: { sentryTrace?: string; baggage?: string },
    callback: () => T,
  ): T;
}

export interface ComapeoSentryConfig {
  /**
   * The host app's already-initialized `@sentry/react-native` (or any
   * object satisfying {@link SentryAdapter}). The module never calls
   * `Sentry.init()`; the host app does, and the native SDK is initialized
   * from manifest/plist values written by the config plugin (Phase 2).
   */
  sentry: SentryAdapter;
}

/**
 * Disposer returned by {@link configureSentry}. Detaches the listeners
 * and clears the stored adapter. Idempotent. Mostly useful for tests;
 * production code wires `configureSentry` once at app start and never
 * tears it down.
 */
export type ComapeoSentryDisposer = () => void;

/**
 * Hand the host app's Sentry adapter to this module. Idempotent —
 * calling twice replaces the previous adapter and detaches the previous
 * listeners. Returns a disposer for tests.
 *
 * Must be called once at app start (after the host has called
 * `Sentry.init()`). State observers attach immediately; the §6.2 RPC
 * client tracing path (Phase 3) reads {@link activeAdapter} at call
 * time, so the order of `configureSentry` vs. first `comapeo.*` call
 * does not matter for that path.
 *
 * This does NOT configure DSN / environment / release. Those are baked
 * into native config at build time by the Expo plugin (`app.plugin.js`,
 * §4.1) and read by both `@sentry/react-native` (in the main process)
 * and the embedded backend (Phase 3).
 */
export function configureSentry(
  config: ComapeoSentryConfig,
): ComapeoSentryDisposer {
  const adapter = config.sentry;

  // Detach any previous listeners — calling configureSentry twice is
  // valid (e.g. a host that re-inits Sentry with a fresh DSN), and the
  // previous closures captured the previous adapter, so we have to
  // unregister them or duplicate breadcrumbs would land on every event.
  detachListeners();

  setActiveAdapter(adapter);
  attachListeners(adapter);

  return () => {
    detachListeners();
    if (activeAdapter() === adapter) setActiveAdapter(null);
  };
}

// ── State listeners ─────────────────────────────────────────────

let stateChangeListener:
  | ((s: ComapeoState, info: ComapeoErrorInfo | null) => void)
  | null = null;
let messageErrorListener: ((err: Error) => void) | null = null;

function attachListeners(adapter: SentryAdapter): void {
  // Per §7.4.1 every transition becomes a breadcrumb. Phase 1 emits
  // these from the JS adapter (main process only); Phase 2b adds
  // FGS-side emissions from `NodeJSService` so the FGS-process scope
  // gets logcat / foreground-state context. The two sources land on
  // different scopes and Sentry de-dupes via fingerprinting on the
  // eventual `captureException`.
  stateChangeListener = (s, info) => {
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

    // Per §6.3 ERROR transitions also fire a captureException. The
    // synthesized Error encodes the phase in the name so Sentry's
    // grouping treats e.g. rootkey vs. starting-timeout as distinct
    // issues without us having to maintain a fingerprint table. The
    // `proc:main` tag pairs with Phase 2b's `proc:fgs` capture from
    // the FGS process, so a single error fanned out to multiple
    // scopes is still filterable per-process in the dashboard.
    if (s === "ERROR" && info) {
      const e = new Error(info.errorMessage);
      e.name = `ComapeoError:${info.errorPhase}`;
      adapter.captureException(e, {
        tags: {
          layer: "rn",
          proc: "main",
          "comapeo.phase": info.errorPhase,
          "comapeo.state": s,
        },
      });
    }
  };

  // Per §6.3 messageerror is a control-socket parse failure; it never
  // changes the lifecycle state, so we capture as a warning rather
  // than escalating to error. `state.messageerror` already wraps the
  // native payload in an Error for ergonomics — but the wrapped
  // message can include arbitrary bytes from a corrupted control
  // frame (the parser surfaces the offending input verbatim for
  // debugging). Truncate before forwarding to Sentry so a runaway
  // payload can't blow event size limits or smuggle binary data
  // into the dashboard.
  messageErrorListener = (err) => {
    const truncated = truncateForSentry(err.message);
    const wrapped = new Error(truncated);
    wrapped.name = err.name;
    adapter.captureException(wrapped, {
      tags: {
        layer: "rn",
        proc: "main",
        source: "control-socket",
      },
      level: "warning",
    });
  };

  state.addListener("stateChange", stateChangeListener);
  state.addListener("messageerror", messageErrorListener);
}

/**
 * Cap on payload bytes we forward into a Sentry event. The control
 * socket framing (`backend/lib/message-port.js`) accepts up to
 * ~16 MB per frame; a corrupted frame the parser couldn't decode
 * could include arbitrary binary bytes. Sentry's per-event size
 * limit is much smaller, and binary noise is useless on the
 * dashboard. 256 chars retains the human-debuggable prefix while
 * keeping events cheap.
 */
const MESSAGE_ERROR_MAX_LEN = 256;

function truncateForSentry(input: string): string {
  if (input.length <= MESSAGE_ERROR_MAX_LEN) return input;
  return `${input.slice(0, MESSAGE_ERROR_MAX_LEN)}… [truncated ${input.length - MESSAGE_ERROR_MAX_LEN} chars]`;
}

function detachListeners(): void {
  if (stateChangeListener) {
    state.removeListener("stateChange", stateChangeListener);
    stateChangeListener = null;
  }
  if (messageErrorListener) {
    state.removeListener("messageerror", messageErrorListener);
    messageErrorListener = null;
  }
}
