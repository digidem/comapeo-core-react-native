/**
 * `@comapeo/core-react-native/sentry` sub-export.
 *
 * This module owns the RN-side `Sentry.init` call — the host calls
 * [initSentry] once at app entry and the module decides DSN, release,
 * sample rates, and user-tier gating based on the persisted
 * `diagnosticsEnabled` / `captureApplicationData` preferences. The host
 * cannot override DSN or sample rates; it can append integrations and
 * chain its own `beforeSend` / `beforeBreadcrumb` after our scrubber.
 *
 * Importing this file as a side effect (`import "@comapeo/core-react-native/sentry"`)
 * attaches the state listeners so they're ready to fire — they no-op
 * until [initSentry] runs and registers the adapter.
 *
 * Tests can inject a fake adapter via [setSentryAdapterForTests].
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
import {
  state,
  readSentryConfig,
  readSentryPreferences,
  setDiagnosticsEnabledNative,
  setCaptureApplicationDataNative,
} from "./ComapeoCoreModule";
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
 * the current/isolation scope.
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
  getTraceData(options?: { span?: SentrySpan }): {
    "sentry-trace"?: string;
    baggage?: string;
  };
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

/**
 * Subset of `Sentry.init` options that map cleanly from values the
 * Expo plugin (`app.plugin.js`) writes into the native config.
 */
export type SentryInitConfig = {
  dsn?: string;
  environment?: string;
  release?: string;
  sampleRate?: number;
  tracesSampleRate?: number;
  enableLogs?: boolean;
};

/**
 * Sentry options the Expo plugin baked into the native config (the
 * same values forwarded to the backend via `--sentry*` argv). Exposed
 * for read-only inspection; [initSentry] is the supported way to wire
 * Sentry up — the host doesn't need to spread this manually.
 *
 * Always-defined: empty object when the plugin isn't registered.
 */
export const sentryConfig: SentryInitConfig = readSentryConfig();

/**
 * Fallback `tracesSampleRate` when the plugin doesn't configure one
 * and `captureApplicationData` is on. Keep in sync with
 * `backend/loader.mjs`'s `DEFAULT_TRACES_SAMPLE_RATE`.
 */
const DEFAULT_TRACES_SAMPLE_RATE = 0.1;

// ── Host extension API ──────────────────────────────────────────

/**
 * Sentry event / breadcrumb shape narrowed to the fields the host
 * `beforeSend` / `beforeBreadcrumb` hooks may inspect or mutate.
 * Loosely typed so consumers aren't forced to depend on
 * `@sentry/react-native`'s exact runtime types.
 */
type AnyEvent = Record<string, unknown>;
type AnyHint = Record<string, unknown> | undefined;
type BeforeSendHook = (event: AnyEvent, hint?: AnyHint) => AnyEvent | null;
type BeforeBreadcrumbHook = (
  breadcrumb: AnyEvent,
  hint?: AnyHint,
) => AnyEvent | null;

/**
 * Allowlisted extensions the host can pass to [initSentry]. Locked
 * fields (`dsn`, `release`, `environment`, `sampleRate`,
 * `tracesSampleRate`, `sendDefaultPii`, `enableLogs`, `user.id`) are
 * NOT here on purpose — TypeScript refuses them at the call site.
 */
export interface InitSentryOptions {
  /**
   * Extend the default integrations. Receives the SDK's defaults
   * and returns the final list — append, replace, or filter as
   * needed. Common case: add `Sentry.reactNavigationIntegration`.
   */
  integrations?: (defaults: unknown[]) => unknown[];
  /**
   * Runs AFTER this module's PII scrubber. If the scrubber drops
   * the event, this hook never sees it. Return `null` to drop.
   */
  beforeSend?: BeforeSendHook;
  /**
   * Runs AFTER this module's breadcrumb scrubber. Return `null`
   * to drop.
   */
  beforeBreadcrumb?: BeforeBreadcrumbHook;
  /** Extra scope tags merged on the persistent global scope. */
  tags?: Record<string, string | number | boolean>;
}

// ── Public toggle API ───────────────────────────────────────────

/**
 * User's saved value (or the plugin/baked default if unset).
 * Restart-to-activate — see [setDiagnosticsEnabled].
 */
export function getDiagnosticsEnabled(): boolean {
  return readSentryPreferences().diagnosticsEnabled;
}

/**
 * Persist the toggle. Resolves when the write has hit disk and (on
 * a transition to false) the on-disk Sentry envelope cache has been
 * wiped. The current process keeps emitting events until the next
 * launch; this is the documented restart-to-activate behaviour, but
 * those events sit in an outbox we've just wiped, so they never
 * upload.
 */
export function setDiagnosticsEnabled(value: boolean): Promise<void> {
  return setDiagnosticsEnabledNative(value);
}

/**
 * User's saved value (or the plugin/baked default if unset). Note
 * that the *effective* value (what actually gates per-RPC traces
 * etc.) is `getCaptureApplicationData() && getDiagnosticsEnabled()`
 * — but the getter returns the saved value so a settings UI can
 * render the toggle's stored state regardless of the diagnostics
 * setting.
 */
export function getCaptureApplicationData(): boolean {
  return readSentryPreferences().captureApplicationData;
}

/** Persist the toggle. See [setDiagnosticsEnabled] for semantics. */
export function setCaptureApplicationData(value: boolean): Promise<void> {
  return setCaptureApplicationDataNative(value);
}

// ── initSentry ──────────────────────────────────────────────────

let initialized = false;

/**
 * Initialise Sentry for the host app. Must be called exactly once at
 * app entry (before any code that captures). The module reads its
 * persisted preferences and either:
 *
 *   - skips `Sentry.init` entirely (diagnosticsEnabled is false) —
 *     adapter stays null and every emit path in this module no-ops;
 *   - throws if the host called `Sentry.init` separately before us
 *     (we own the init lifecycle now); or
 *   - calls `Sentry.init` with locked options merged with the host's
 *     allowlisted extensions.
 *
 * Locked options:
 * - `dsn`, `release`, `environment`, `sampleRate`, `enableLogs` —
 *   from `sentryConfig` (the Expo plugin's prebuild output).
 * - `sendDefaultPii: false` — privacy default; not overridable.
 * - `tracesSampleRate` — 0 when capture-application-data is off, the
 *   plugin's configured value (default 0.1) when on.
 * - PII scrubber (currently an identity no-op; full implementation
 *   lands in the subsequent phase) runs before any host `beforeSend`.
 */
export function initSentry(options: InitSentryOptions = {}): void {
  if (initialized) {
    throw new Error(
      "initSentry called twice. This module owns the Sentry init " +
        "lifecycle; call it exactly once at app entry.",
    );
  }

  // Refuse to run if the host called Sentry.init themselves. Checked
  // BEFORE the `initialized` flag flips so that a host who catches
  // and retries this error gets the diagnostic message again rather
  // than the less-specific "called twice" on the second attempt.
  // The wrapper exists precisely so the host can't independently
  // configure DSN / user.id / sample rates — having two competing
  // SentryClients would defeat the gating.
  const maybeIsInitialized = (Sentry as unknown as {
    isInitialized?: () => boolean;
  }).isInitialized;
  if (typeof maybeIsInitialized === "function" && maybeIsInitialized()) {
    throw new Error(
      "@comapeo/core-react-native: detected an existing Sentry.init " +
        "call before initSentry() ran. This module now owns the " +
        "Sentry init lifecycle. Remove your `Sentry.init({...})` " +
        "call and pass extensions (integrations, beforeSend, etc.) " +
        "to `initSentry()` instead.",
    );
  }

  initialized = true;

  const preferences = readSentryPreferences();
  if (!preferences.diagnosticsEnabled) {
    // User opted out. Skip Sentry.init; adapter stays null; state
    // listeners (attached at module load below) no-op.
    return;
  }

  if (!sentryConfig.dsn) {
    // No DSN baked in — plugin isn't registered or registered without
    // a `sentry` argument. There's nothing to init against. Match
    // the prior "graceful no-op" shape so installs without Sentry
    // don't have to gate their initSentry call.
    return;
  }

  // 0 when off; plugin value (or DEFAULT_TRACES_SAMPLE_RATE) when on.
  // Locked — the host extension API can't override this.
  const effectiveTracesSampleRate = preferences.captureApplicationData
    ? sentryConfig.tracesSampleRate ?? DEFAULT_TRACES_SAMPLE_RATE
    : 0;

  // PII scrubber — currently identity. Substring scan (rootKey,
  // base64-22-char, lat/lng) TBD; chain shape is wired now so the
  // host contract doesn't have to change later.
  const ourBeforeSend: BeforeSendHook = (event) => event;
  const ourBeforeBreadcrumb: BeforeBreadcrumbHook = (crumb) => crumb;

  const chainedBeforeSend = chainHook(ourBeforeSend, options.beforeSend);
  const chainedBeforeBreadcrumb = chainHook(
    ourBeforeBreadcrumb,
    options.beforeBreadcrumb,
  );

  Sentry.init({
    dsn: sentryConfig.dsn,
    environment: sentryConfig.environment,
    release: sentryConfig.release,
    sampleRate: sentryConfig.sampleRate,
    tracesSampleRate: effectiveTracesSampleRate,
    // Locked.
    sendDefaultPii: false,
    // Plugin-controlled. Off by default; opt in via plugin config.
    enableLogs: sentryConfig.enableLogs ?? false,
    integrations: (defaults: unknown[]) =>
      options.integrations ? options.integrations(defaults) : defaults,
    beforeSend: chainedBeforeSend as never,
    beforeBreadcrumb: chainedBeforeBreadcrumb as never,
  } as never);

  // Register only after init so callers don't hit a pre-init SDK.
  registerAdapter({
    ...(Sentry as unknown as Omit<SentryAdapter, "getTraceData">),
    getTraceData: coreGetTraceData as unknown as SentryAdapter["getTraceData"],
  });

  // Scope-default tags via global scope (survives later forks).
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
    if (options.tags) {
      for (const [k, v] of Object.entries(options.tags)) {
        globalScope.setTag(k, v);
      }
    }
  }
}

function chainHook<T extends AnyEvent>(
  ours: (x: T, hint?: AnyHint) => T | null,
  theirs?: (x: T, hint?: AnyHint) => T | null,
): (x: T, hint?: AnyHint) => T | null {
  if (!theirs) return ours;
  return (x, hint) => {
    const scrubbed = ours(x, hint);
    if (scrubbed === null) return null;
    return theirs(scrubbed, hint);
  };
}

// ── State listeners ─────────────────────────────────────────────
//
// Attached at module load (no-op until initSentry registers the
// adapter). Keeping them at module level rather than inside
// `initSentry` means a host that imports the sub-export but never
// calls `initSentry()` (e.g. test contexts using
// `setSentryAdapterForTests`) still gets the listener wiring.

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
