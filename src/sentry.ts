/**
 * `@comapeo/core-react-native/sentry` sub-export.
 *
 * This module owns the RN-side `Sentry.init` call — the host calls
 * [initSentry] once at app entry and the module decides DSN, release,
 * sample rates, and user-tier gating based on the persisted
 * `diagnosticsEnabled` / `applicationUsageData` / `debug` preferences. The host
 * cannot override DSN or sample rates; it can append integrations and
 * chain its own `beforeSend` / `beforeBreadcrumb` after our scrubber.
 *
 * Importing this file as a side effect (`import "@comapeo/core-react-native/sentry"`)
 * attaches the state listeners so they're ready to fire — they no-op
 * until [initSentry] runs and flips `sentryReady`.
 */
import { Platform } from "react-native";
import * as Sentry from "@sentry/react-native";

import {
  state,
  readSentryConfig,
  readSentryPreferencesAtLaunch,
  readCurrentSentryPreferences,
  readRootUserIdNative,
  setDiagnosticsEnabledNative,
  setApplicationUsageDataNative,
  setDebugEnabledNative,
  type SentryPreferences,
} from "./ComapeoCoreModule";
import type { ComapeoErrorInfo, ComapeoState } from "./ComapeoCore.types";
import { SentryTags } from "./sentry-tags";
import { scrubEvent, scrubBreadcrumb, scrubLog } from "./sentry-scrub";
import {
  BACKEND_MODULES,
  COMAPEO_MODULE_VERSION_LABEL,
} from "./version";

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
  /**
   * Device-classification tags computed once at native process start.
   * Attached to the duration metrics as low-cardinality attributes — see
   * `sentry-metrics.ts`. Absent in test contexts / pre-attach.
   */
  deviceTags?: SentryDeviceTags;
  /**
   * Derived Sentry `user.id` for this launch, computed natively from the
   * permanent root user ID: a monthly-rotating hash by default, a
   * permanent hash when the user opted in to application-usage data.
   * Never the root ID itself. Applied via `Sentry.setUser` by
   * [initSentry]; locked (the host can't override it).
   */
  userId?: string;
};

/**
 * Low-cardinality device classification. `deviceClass`
 * buckets RAM + CPU cores into low/mid/high; `osMajor` is
 * `<platform>.<major>`; `platform` is `ios` / `android`.
 */
export type SentryDeviceTags = {
  platform: string;
  deviceClass: string;
  osMajor: string;
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

// In-memory view of the current saved preferences. Seeded lazily from the
// native current-value read (one synchronous native call, not once per
// render), then kept in sync by the setters so a settings screen can read a
// toggle back mid-session without its own state. Module-level, so a JS reload
// drops it and it re-seeds from the native read — reflecting any change made
// since the native process launched. Distinct from the launch snapshot the
// module's own behaviour is pinned to (see [initSentry]).
let currentPreferences: SentryPreferences | undefined;

function livePreferences(): SentryPreferences {
  return (currentPreferences ??= readCurrentSentryPreferences());
}

/**
 * The user's current saved value (or the plugin/baked default if unset).
 * Reflects a [setDiagnosticsEnabled] made earlier this session and survives a
 * JS reload, so a settings screen can read it back without keeping its own
 * copy. This is the *saved* value, which is restart-to-activate: the value
 * governing whether Sentry actually emits this session is fixed at launch
 * (see [initSentry]).
 */
export function getDiagnosticsEnabled(): boolean {
  return livePreferences().diagnosticsEnabled;
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
  livePreferences().diagnosticsEnabled = value;
  return setDiagnosticsEnabledNative(value);
}

/**
 * The user's current saved application-usage-data preference (or the
 * plugin/baked default if unset). See [getDiagnosticsEnabled] for the
 * saved-vs-active distinction.
 */
export function getApplicationUsageData(): boolean {
  return livePreferences().applicationUsageData;
}

/** Persist the toggle. See [setDiagnosticsEnabled] for semantics. */
export function setApplicationUsageData(value: boolean): Promise<void> {
  livePreferences().applicationUsageData = value;
  return setApplicationUsageDataNative(value);
}

/**
 * The user's current saved `debug` value (or the plugin/baked default if
 * unset). See [getDiagnosticsEnabled] for the saved-vs-active distinction.
 * This is the raw saved toggle; the 72h auto-off is applied natively at
 * launch, so a still-`true` value here means "on, pending the next-launch
 * expiry check". `debug` gates per-RPC traces, `@comapeo/core` OTel spans,
 * backend `consoleIntegration`, and `rpc.args` capture.
 */
export function getDebugEnabled(): boolean {
  return livePreferences().debug;
}

/**
 * Persist the `debug` toggle. Writing `true` (re)starts the 72h
 * auto-off window. See [setDiagnosticsEnabled] for the
 * restart-to-activate semantics.
 */
export function setDebugEnabled(value: boolean): Promise<void> {
  livePreferences().debug = value;
  return setDebugEnabledNative(value);
}

/**
 * The permanent per-install root user ID (lazily generated on first
 * read; reset by uninstall). Sentry never sees this value — the
 * `user.id` on events is a hash derived from it (monthly-rotating by
 * default, permanent under the usage opt-in), so both derivations can
 * be recomputed from a user-shared root ID to re-associate historical
 * events for a support case. Intended for a debug/about screen.
 */
export function getRootUserId(): string {
  return readRootUserIdNative();
}

// ── initSentry ──────────────────────────────────────────────────

let initialized = false;
// Flipped only after `Sentry.init` succeeds. State listeners gate on
// this so a process where `initSentry` early-returned (toggle off,
// no DSN) doesn't emit breadcrumbs / captures against an un-init'd
// SDK. The SDK no-ops these calls itself, but skipping the work
// keeps logs and tests clean.
let sentryReady = false;

/**
 * Initialise Sentry for the host app. Must be called exactly once at
 * app entry (before any code that captures). The module reads its
 * persisted preferences and either:
 *
 *   - skips `Sentry.init` entirely (diagnosticsEnabled is false) —
 *     every emit path in this module no-ops;
 *   - throws if the host called `Sentry.init` separately before us
 *     (we own the init lifecycle now); or
 *   - calls `Sentry.init` with locked options merged with the host's
 *     allowlisted extensions.
 *
 * Locked options:
 * - `dsn`, `release`, `environment`, `sampleRate`, `enableLogs` —
 *   from `sentryConfig` (the Expo plugin's prebuild output).
 * - `sendDefaultPii: false` — privacy default; not overridable.
 * - `tracesSampleRate` — 1.0 when `debug` is on, 0 otherwise. Per-RPC
 *   traces are investigation-only; metrics carry the day-to-day signal.
 * - PII scrubber runs before any host `beforeSend`.
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
  //
  // `isInitialized` isn't on `@sentry/react-native`'s public type
  // surface (it lives in `@sentry/core`'s utilities and is exposed
  // through the namespace at runtime). Defensive accessor handles
  // older SDK releases where the helper isn't wired through.
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

  const preferences = readSentryPreferencesAtLaunch();
  if (!preferences.diagnosticsEnabled) {
    // User opted out. Skip Sentry.init; state listeners (attached at
    // module load below) stay no-op via `sentryReady`.
    return;
  }

  if (!sentryConfig.dsn) {
    // No DSN baked in — plugin isn't registered or registered without
    // a `sentry` argument. There's nothing to init against. Match
    // the prior "graceful no-op" shape so installs without Sentry
    // don't have to gate their initSentry call.
    return;
  }

  // Same trace-sampling decision the native side folds into the backend's
  // rate: full while the `debug` window is on, else the plugin-configured cap
  // (0 if unset). Day-to-day perf signal rides the always-on metrics layer.
  // Locked — the host extension API can't override this.
  const effectiveTracesSampleRate = preferences.debug
    ? 1.0
    : (sentryConfig.tracesSampleRate ?? 0);

  // PII scrubber — substring scan for rootKey + lat/lng markers across
  // every text field. Runs BEFORE any host `beforeSend` so a buggy or
  // malicious host never sees a raw payload.
  const ourBeforeSend: BeforeSendHook = (event) => scrubEvent(event);
  // URL-scrubbing breadcrumb hook: HTTP breadcrumbs reduced to
  // host-only so request paths/queries don't leak.
  const ourBeforeBreadcrumb: BeforeBreadcrumbHook = (crumb) =>
    scrubBreadcrumb(crumb);

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
    // iOS only: native init runs in `AppLifecycleDelegate.didFinishLaunching`
    // (before `applicationDidBecomeActive` fires `nodeService.start()`),
    // so JS-side init must NOT re-initialise sentry-cocoa or it would
    // replace the live client mid-flight. On Android the main process
    // has no equivalent native init (the FGS process inits its own
    // sentry-android via `SentryFgsBridge.init` in
    // `ComapeoCoreService.onCreate`, but that doesn't reach the main
    // process), so JS-triggered init via `RNSentry` is what brings the
    // main-process sentry-android up. Keep the default `true` there.
    ...(Platform.OS === "ios" ? { autoInitializeNativeSdk: false } : {}),
    // Locked.
    sendDefaultPii: false,
    // Plugin-controlled. Off by default; opt in via plugin config.
    enableLogs: sentryConfig.enableLogs ?? false,
    integrations: (defaults: unknown[]) =>
      options.integrations ? options.integrations(defaults) : defaults,
    beforeSend: chainedBeforeSend as never,
    beforeBreadcrumb: chainedBeforeBreadcrumb as never,
    // Structured logs (`Sentry.logger.*`) bypass beforeSend/beforeBreadcrumb,
    // so scrub them on their own hook — our state/message-error logs and any
    // host logs.
    beforeSendLog: (log: { message?: unknown; attributes?: unknown }) =>
      scrubLog(log),
  } as never);

  sentryReady = true;

  // Locked user.id — the native-derived monthly/permanent hash, shared
  // with the FGS and backend layers so one launch reports one user.
  if (sentryConfig.userId) {
    Sentry.setUser({ id: sentryConfig.userId });
  }

  // Scope-default tags via global scope (survives later forks).
  const globalScope = Sentry.getGlobalScope();
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
// Attached at module load (no-op until initSentry flips
// `sentryReady`). Keeping them at module level rather than inside
// `initSentry` means a host that imports the sub-export but never
// calls `initSentry()` still gets the listener wiring; gating on
// `sentryReady` keeps the listeners quiet in that case.

state.addListener("stateChange", handleStateChange);
state.addListener("messageerror", handleMessageError);

function handleStateChange(s: ComapeoState, info: ComapeoErrorInfo | null) {
  if (!sentryReady) return;

  const data = info
    ? {
        state: s,
        errorPhase: info.errorPhase,
        errorMessage: info.errorMessage,
      }
    : { state: s };
  Sentry.addBreadcrumb({
    category: "comapeo.state",
    type: "state",
    level: s === "ERROR" ? "error" : "info",
    message: `comapeo state → ${s}`,
    data,
  });
  const logFn = s === "ERROR" ? Sentry.logger.error : Sentry.logger.info;
  logFn(`comapeo state → ${s}`, data);

  // Synthesised Error name encodes the phase so Sentry's grouping
  // treats e.g. rootkey vs. starting-timeout as distinct issues
  // without us maintaining a fingerprint table.
  if (s === "ERROR" && info) {
    const e = new Error(info.errorMessage);
    e.name = `ComapeoError:${info.errorPhase}`;
    Sentry.captureException(e, {
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
  if (!sentryReady) return;

  // Truncate before forwarding — the wrapped message echoes the
  // raw control frame, which can include arbitrary bytes from a
  // corrupted parse. 256 chars retains the readable prefix.
  const truncated = truncateForSentry(err.message);
  const wrapped = new Error(truncated);
  wrapped.name = err.name;
  Sentry.captureException(wrapped, {
    tags: {
      [SentryTags.layer]: SentryTags.layerRn,
      [SentryTags.proc]: SentryTags.procMain,
      [SentryTags.source]: "control-socket",
    },
    level: "warning",
  });
  Sentry.logger.warn(truncated, {
    [SentryTags.source]: "control-socket",
    "exception.name": err.name,
  });
}

const MESSAGE_ERROR_MAX_LEN = 256;

function truncateForSentry(input: string): string {
  if (input.length <= MESSAGE_ERROR_MAX_LEN) return input;
  return `${input.slice(0, MESSAGE_ERROR_MAX_LEN)}… [truncated ${input.length - MESSAGE_ERROR_MAX_LEN} chars]`;
}

