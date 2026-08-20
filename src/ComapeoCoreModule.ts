import { NativeModule, requireNativeModule, EventEmitter } from "expo";
import type { JsonValue } from "type-fest";
import {
  type ComapeoCoreModuleEvents,
  type ComapeoErrorInfo,
  type ComapeoState,
  type MessageErrorEventPayload,
  type MessageEventPayload,
  type NotificationPermissionResponse,
  type StateChangeEventPayload,
  type TransportStateChangeEventPayload,
} from "./ComapeoCore.types.js";
import type { MessagePortLike } from "rpc-reflector";
import {
  createComapeoCoreClient,
  createComapeoServicesClient,
  notifyTransportReset,
  resubscribe,
  type ComapeoCoreClientApi,
  type ComapeoServicesClientApi,
} from "@comapeo/ipc/client.js";
import * as Sentry from "@sentry/react-native";
// `getTraceData` / `startNewTrace` aren't re-exported from
// `@sentry/react-native@7`; `@sentry/core` is a direct dep of RN so
// the import is safe.
import { getTraceData, startNewTrace } from "@sentry/core";
import type { SentryInitConfig } from "./sentry.js";
import { rpcClientMetric, rpcStatusFor } from "./sentry-metrics.js";

// `onRequestHook` request type derived from `createComapeoCoreClient` so
// any hook-signature change up-stream is a compile error here. The
// hook input omits `metadata`; we re-add it to write into `next(...)`.
type IpcHookRequest = Parameters<
  NonNullable<
    NonNullable<Parameters<typeof createComapeoCoreClient>[1]>["onRequestHook"]
  >
>[0];
type IpcRequestWithMetadata = IpcHookRequest & {
  metadata?: Record<string, string>;
};

/**
 * User-persisted sentry preferences (snapshot at module construction).
 * Diagnostics on by default; application-usage-data and debug off by
 * default. Plugin `diagnosticsEnabledDefault` /
 * `applicationUsageDataDefault` / `debugDefault` change the
 * fresh-install defaults but not the user's saved choice.
 */
export type SentryPreferences = {
  diagnosticsEnabled: boolean;
  applicationUsageData: boolean;
  debug: boolean;
};

declare class ComapeoCoreModule extends NativeModule<ComapeoCoreModuleEvents> {
  postMessage(value: string): void;
  getState(): ComapeoState;
  getLastError(): ComapeoErrorInfo | null;
  /**
   * Boot nonce of the backend currently serving (from its latest control
   * `ready` frame); `null` before the first `ready`. Android only —
   * optional so iOS and older natives fall back to `null`.
   */
  getBootNonce?(): string | null;
  /**
   * Sentry options the Expo plugin baked into the native config.
   * Empty object when the plugin isn't registered (or DSN absent).
   */
  readonly sentryConfig: SentryInitConfig;
  /**
   * User-persisted preferences as read at native module construction —
   * the **launch snapshot** that governs this session's Sentry behaviour
   * (whether `initSentry` emits, the metrics usage tier, debug tracing).
   * Immutable this session; `setX` writes only take effect on the next
   * launch. For the current saved value (e.g. a settings screen reading
   * back a just-made toggle) use `getCurrentSentryPreferences()`.
   */
  readonly sentryPreferencesAtLaunch: SentryPreferences;
  /**
   * Live read of the current persisted preferences — reflects a `setX`
   * made this session and survives a JS reload (unlike the
   * `sentryPreferencesAtLaunch` snapshot). `debug` is the raw stored value,
   * without the launch-time 72h auto-off side effect. Backs the public
   * `getDiagnosticsEnabled` / `getApplicationUsageData` / `getDebugEnabled`
   * getters.
   */
  getCurrentSentryPreferences(): SentryPreferences;
  /**
   * Persist `diagnosticsEnabled` and (on a transition to false) wipe
   * the on-disk Sentry envelope cache so queued events from the
   * current session never ship. Restart-to-activate: the current
   * process keeps emitting until the next launch.
   */
  setDiagnosticsEnabled(value: boolean): Promise<void>;
  /**
   * Same shape as `setDiagnosticsEnabled` but for the
   * `applicationUsageData` toggle. Outbox wipe on false is full
   * (not just trace envelopes) — selective wipe would be a lot of
   * code for the same effect when an outbox is mixed.
   */
  setApplicationUsageData(value: boolean): Promise<void>;
  /**
   * Persist the `debug` toggle and (on a transition to true) stamp the
   * enable time so the 72h auto-off can fire on a later launch.
   * Restart-to-activate.
   */
  setDebugEnabled(value: boolean): Promise<void>;
  /**
   * The permanent per-install root user ID (lazily generated on first
   * read). Never sent to Sentry — the Sentry `user.id` is a hash derived
   * from it natively. For debug/about screens so a user can share it.
   */
  getSentryRootUserId(): string;
  /**
   * Current notification-permission status without prompting. On Android
   * < 13 (API 33) and on iOS this resolves as `granted` (no-op).
   */
  getNotificationPermissionsAsync(): Promise<NotificationPermissionResponse>;
  /**
   * Request the notification permission, showing the system dialog on
   * Android 13+ when the status is `undetermined`. Resolves with the
   * post-request status. On Android < 13 and on iOS this resolves as
   * `granted` without prompting.
   */
  requestNotificationPermissionsAsync(): Promise<NotificationPermissionResponse>;
}

// This call loads the native module object from the JSI.
const nativeModule = requireNativeModule<ComapeoCoreModule>("ComapeoCore");

/**
 * Sentry options baked into the native config by the Expo plugin.
 * Re-exported as `sentryConfig` from the `/sentry` sub-export for
 * read-only inspection (e.g. logging which release is in use).
 * `initSentry()` is the supported way to wire Sentry up — the host
 * does NOT spread this into its own `Sentry.init` call.
 *
 * Always-defined: an empty object when the plugin isn't registered.
 */
export function readSentryConfig(): SentryInitConfig {
  return nativeModule.sentryConfig ?? {};
}

/**
 * The launch snapshot of the sentry preferences: read once at native module
 * construction, so `setDiagnosticsEnabled` / `setApplicationUsageData` /
 * `setDebugEnabled` writes only take effect on the next launch. This is what
 * the module's own session behaviour (initSentry, metrics tier, debug tracing)
 * is pinned to. Falls back to safe defaults (diagnostics on, usage off, debug
 * off) when the native module isn't available (test contexts).
 */
export function readSentryPreferencesAtLaunch(): SentryPreferences {
  const raw = nativeModule.sentryPreferencesAtLaunch as
    | SentryPreferences
    | undefined;
  if (!raw) {
    return {
      diagnosticsEnabled: true,
      applicationUsageData: false,
      debug: false,
    };
  }
  return normalizePreferences(raw);
}

/**
 * The current saved preferences — reflects a `setX` made this session and
 * survives a JS reload, so a settings screen can read back the user's choice
 * without maintaining its own copy. Distinct from
 * [readSentryPreferencesAtLaunch] (the launch snapshot the session is pinned
 * to); this is the current on-disk value. Falls back to the snapshot when the
 * native live getter isn't available (older native / test contexts).
 */
export function readCurrentSentryPreferences(): SentryPreferences {
  const live = nativeModule.getCurrentSentryPreferences?.() as
    | SentryPreferences
    | undefined;
  return live ? normalizePreferences(live) : readSentryPreferencesAtLaunch();
}

function normalizePreferences(raw: SentryPreferences): SentryPreferences {
  return {
    diagnosticsEnabled: raw.diagnosticsEnabled,
    applicationUsageData: raw.applicationUsageData ?? false,
    debug: raw.debug ?? false,
  };
}

/** Persist `diagnosticsEnabled`. See `setDiagnosticsEnabled` JSDoc. */
export function setDiagnosticsEnabledNative(value: boolean): Promise<void> {
  return nativeModule.setDiagnosticsEnabled(value);
}

/** Persist `applicationUsageData`. See `setApplicationUsageData` JSDoc. */
export function setApplicationUsageDataNative(value: boolean): Promise<void> {
  return nativeModule.setApplicationUsageData(value);
}

/** Persist `debug`. See `setDebugEnabled` JSDoc. */
export function setDebugEnabledNative(value: boolean): Promise<void> {
  return nativeModule.setDebugEnabled(value);
}

/**
 * The permanent root user ID from native prefs. Empty string when the
 * native module isn't available (test contexts).
 */
export function readRootUserIdNative(): string {
  return nativeModule.getSentryRootUserId?.() ?? "";
}

const GRANTED_PERMISSION: NotificationPermissionResponse = {
  status: "granted",
  granted: true,
  canAskAgain: true,
  expires: "never",
};

/**
 * Read the notification-permission status without prompting.
 *
 * The module exposes this so the host app can decide when (and whether) to
 * surface a rationale before requesting. The FGS notification is suppressed
 * on Android 13+ without this grant, which lets the system deprioritise or
 * kill the service — see `docs/ForegroundService.md`.
 *
 * Falls back to `granted` when the native module isn't available (test
 * contexts) so cross-platform host code never has to branch on platform.
 */
export function getNotificationPermissionsAsync(): Promise<NotificationPermissionResponse> {
  return (
    nativeModule.getNotificationPermissionsAsync?.() ??
    Promise.resolve(GRANTED_PERMISSION)
  );
}

/**
 * Request the notification permission, showing the system dialog on
 * Android 13+ when the status is `undetermined`. The host app owns the
 * UX around this call (rationale, and the settings deep-link once
 * `canAskAgain` is `false`). See `docs/ForegroundService.md`.
 *
 * Falls back to `granted` when the native module isn't available (test
 * contexts).
 */
export function requestNotificationPermissionsAsync(): Promise<NotificationPermissionResponse> {
  return (
    nativeModule.requestNotificationPermissionsAsync?.() ??
    Promise.resolve(GRANTED_PERMISSION)
  );
}

type MessagePortEvents = {
  message: (event: { data: JsonValue }) => void;
};

// The expo EventEmitter calls startObserving/stopObserving when the first
// listener is added and the last listener is removed.
class CoreMessagePort
  extends EventEmitter<MessagePortEvents>
  implements MessagePortLike
{
  postMessage(value: JsonValue) {
    nativeModule.postMessage(JSON.stringify(value));
  }

  startObserving<EventName extends keyof MessagePortEvents>(
    eventName: EventName,
  ): void {
    if (eventName === "message") {
      nativeModule.addListener("message", this.#handleMessageEvent);
    }
  }

  stopObserving<EventName extends keyof MessagePortEvents>(
    eventName: EventName,
  ): void {
    if (eventName === "message") {
      nativeModule.removeListener("message", this.#handleMessageEvent);
    }
  }

  #handleMessageEvent = (event: MessageEventPayload) => {
    try {
      const message = JSON.parse(event.data);
      this.emit("message", { data: message });
    } catch {
      console.error("Failed to parse message event data", event.data);
    }
  };

  addEventListener<EventName extends keyof MessagePortEvents>(
    eventName: EventName,
    listener: MessagePortEvents[EventName],
  ) {
    this.addListener(eventName, listener);
  }

  removeEventListener<EventName extends keyof MessagePortEvents>(
    eventName: EventName,
    listener: MessagePortEvents[EventName],
  ) {
    this.removeListener(eventName, listener);
  }
}

const messagePort = new CoreMessagePort();

const noop = () => {};

// RPC client tracing. Registered unconditionally so consumers that
// imported `comapeo` before the `/sentry` sub-export's side effects
// ran still get traced; the `!parentSpan` short-circuit is the no-op
// path. The trace headers it injects on `request.metadata` are
// consumed by `backend/lib/comapeo-rpc.js`.
// 30s aligns with NodeJSService's `startupTimeout` — covers cold-boot
// RPC calls issued before the backend reaches STARTED (the message port
// buffers, but rpc-reflector's per-call timer starts on invocation, so
// the default 5s is shorter than a cold boot). After the watchdog fires,
// the backend transitions to ERROR and in-flight calls fail via the
// transport closing, not via this timeout.
const RPC_TIMEOUT_MS = 30_000;

/**
 * `true` if there's an active span whose ROOT span op is meaningful
 * as a parent for an RPC — i.e. user-initiated work like navigation
 * or a tap. The `appStartIntegration`'s `app.start.*` transaction is
 * explicitly NOT a meaningful parent: it stays open for ~10s after
 * launch and would otherwise sweep any RPC fired during that window
 * into the App Start trace.
 */
function hasInheritableActiveSpan(): boolean {
  const active = Sentry.getActiveSpan();
  if (!active) return false;
  const root = Sentry.getRootSpan(active);
  const rootOp = Sentry.spanToJSON(root).op;
  if (typeof rootOp !== "string") return true;
  // The `appStartIntegration` keeps its transaction open for ~10s
  // post-launch; RPCs fired during that window would otherwise get
  // swept into the App Start trace. The transaction's op is
  // `ui.load` (not `app.start.*` — that's only on its children), so
  // we filter both. Everything else with an active span (navigation,
  // tap, host-instrumented work) is a meaningful parent the RPC
  // should join.
  return rootOp !== "ui.load" && !rootOp.startsWith("app.start.");
}

/**
 * `true` when per-RPC tracing is active — `diagnosticsEnabled && debug`
 * with the SDK actually initialised. Read once at module construction
 * (snapshot-at-boot, like the rest of the preferences) so a per-call
 * branch stays cheap.
 */
const debugTracingEnabled = (() => {
  const prefs = readSentryPreferencesAtLaunch();
  return prefs.diagnosticsEnabled && prefs.debug;
})();

export const comapeo: ComapeoCoreClientApi = createComapeoCoreClient(
  messagePort,
  {
    timeout: RPC_TIMEOUT_MS,
    onRequestHook: (request, next) => {
      // Sentry-not-initialised guard. `isInitialized` lives in `@sentry/core`
      // and is reachable through the namespace at runtime but isn't on the
      // public type surface — defensive accessor in case the helper isn't
      // wired through in older SDK releases.
      const isInitialized = (
        Sentry as unknown as {
          isInitialized?: () => boolean;
        }
      ).isInitialized;
      const sentryUp = typeof isInitialized !== "function" || isInitialized();
      const method = request.method.join(".");

      // Metrics/tracing only — the hook never captures exceptions. An RPC
      // rejection is often expected control flow (e.g. NotFound) that the
      // caller may not want reported; deciding what's report-worthy is the
      // caller's job, at the call site. The metric layer no-ops when Sentry is
      // off. Per-RPC traces (below) only run under `debug`.
      const recordMetric = (start: number, status: string) => {
        rpcClientMetric(method, status, performance.now() - start);
      };

      if (!sentryUp || !debugTracingEnabled) {
        const start = performance.now();
        const responsePromise = next(request);
        responsePromise
          .then(
            () => recordMetric(start, "ok"),
            (error: unknown) => recordMetric(start, rpcStatusFor(error)),
          )
          .catch(noop);
        return;
      }

      const runSpan = () =>
        Sentry.startSpan(
          {
            name: method,
            op: "rpc.client",
            forceTransaction: true,
            attributes: {
              "rpc.system": "comapeo-ipc",
              "rpc.method": method,
            },
          },
          async (span) => {
            const { "sentry-trace": sentryTrace, baggage } = getTraceData({
              span,
            });
            const tracedRequest: IpcRequestWithMetadata = sentryTrace
              ? {
                  ...request,
                  metadata: {
                    "sentry-trace": sentryTrace,
                    baggage: baggage ?? "",
                  },
                }
              : request;
            // Record the metric while the span is active so it links to the
            // trace. Duration is measured around the same round-trip the
            // span brackets.
            const start = performance.now();
            try {
              // Split the span duration into "sync send" (JSI hop + UDS write
              // to Node) and "await" (entire round-trip incl. response delivery
              // back to the JS thread). If the gap between this span and the
              // Node-side rpc span is dominated by JS-thread contention on
              // cold boot, `rn.send.syncMs` stays small while total stays high.
              const sendStart = performance.now();
              const responsePromise = next(tracedRequest);
              const sendMs = performance.now() - sendStart;
              span.setAttribute?.("rn.send.syncMs", sendMs);
              await responsePromise;
              span.setStatus?.({ code: 1, message: "ok" });
              recordMetric(start, "ok");
            } catch (error) {
              // Mark the span errored for tracing, but do not capture an issue
              // — see the metrics-only note on the non-debug path above.
              span.setStatus?.({ code: 2, message: "internal_error" });
              recordMetric(start, rpcStatusFor(error));
            }
          },
        );
      // Mint a fresh trace_id when there's no caller context worth
      // inheriting. Without `startNewTrace`, every standalone RPC pulls
      // the trace_id from the isolation-scope's propagation context,
      // which is set once at SDK init and never rotates — so unrelated
      // RPC calls (across reloads, even across days) end up sharing
      // one trace. Skip `app.start.*` parents specifically: the
      // `appStartIntegration` keeps its transaction open for ~10s
      // post-launch, which would otherwise sweep any RPC fired during
      // that window into the App Start trace and make the dashboard
      // render them as nested under it.
      if (hasInheritableActiveSpan()) {
        runSpan();
      } else {
        startNewTrace(runSpan);
      }
    },
  },
);

type StateEvents = {
  stateChange: (state: ComapeoState, error: ComapeoErrorInfo | null) => void;
  /**
   * Fires when the native control-socket parser receives a frame it
   * can't process (non-JSON, missing `type`, or unknown `type`).
   * Mirrors DOM MessagePort's `messageerror`: a malformed frame is
   * surfaced on a separate channel rather than transitioning to
   * `ERROR`, so a debug listener can capture protocol issues without
   * affecting the lifecycle state. The `Error.message` is a
   * developer-facing description; do not display directly to users.
   */
  messageerror: (error: Error) => void;
};

/**
 * JS-facing observer for the embedded service's lifecycle. Mirrors the
 * `comapeo` MessagePort surface: `getState()` for a one-shot read,
 * `addListener("stateChange", ...)` for push notifications.
 *
 * State transitions are sourced from the native module's `stateChange`
 * event. iOS derives this from the in-process `NodeJSService.onStateChange`
 * callback. Android derives it from the control-socket messages
 * (`started`/`ready`/`error`) plus the IPC's connection-state stream.
 *
 * When the new state is `"ERROR"`, the event payload carries
 * `errorPhase`/`errorMessage`. Listeners receive a second argument with
 * the same detail; `getLastError()` returns the last captured error
 * (null if the service has not entered ERROR since process start).
 *
 * `messageerror` is a separate channel for control-socket parse
 * failures. It does not change the lifecycle state.
 */
class State extends EventEmitter<StateEvents> {
  getState(): ComapeoState {
    return nativeModule.getState();
  }

  getLastError(): ComapeoErrorInfo | null {
    return nativeModule.getLastError();
  }

  /**
   * The boot nonce of the backend process currently serving — one random
   * UUID per backend process, carried on the control channel's `ready`
   * frame. `null` before the backend first reaches `STARTED`, on iOS, and
   * with backends that predate the field. A changed nonce across a
   * reconnect means the backend restarted (see [subscribeToBackendRestart]).
   */
  getBootNonce(): string | null {
    return nativeModule.getBootNonce?.() ?? null;
  }

  startObserving<EventName extends keyof StateEvents>(
    eventName: EventName,
  ): void {
    if (eventName === "stateChange") {
      nativeModule.addListener("stateChange", this.#handleStateChangeEvent);
    } else if (eventName === "messageerror") {
      nativeModule.addListener("messageerror", this.#handleMessageErrorEvent);
    }
  }

  stopObserving<EventName extends keyof StateEvents>(
    eventName: EventName,
  ): void {
    if (eventName === "stateChange") {
      nativeModule.removeListener("stateChange", this.#handleStateChangeEvent);
    } else if (eventName === "messageerror") {
      nativeModule.removeListener(
        "messageerror",
        this.#handleMessageErrorEvent,
      );
    }
  }

  #handleStateChangeEvent = (event: StateChangeEventPayload) => {
    const error: ComapeoErrorInfo | null =
      event.state === "ERROR" && event.errorPhase && event.errorMessage
        ? { errorPhase: event.errorPhase, errorMessage: event.errorMessage }
        : null;
    this.emit("stateChange", event.state, error);
  };

  #handleMessageErrorEvent = (event: MessageErrorEventPayload) => {
    this.emit("messageerror", new Error(event.data));
  };
}

export const state = new State();

export const comapeoServicesClient: ComapeoServicesClientApi =
  createComapeoServicesClient(messagePort, {
    timeout: RPC_TIMEOUT_MS,
  });

/**
 * A call that was in flight when the RPC transport dropped rejects with this
 * error (rpc-reflector's `ChannelClosedError`, `code: "RPC_CHANNEL_CLOSED"`)
 * instead of hanging until the RPC timeout. The call's response will never
 * arrive — the call itself may or may not have executed on the backend before
 * it went away — so a read is safe to retry once the backend is back
 * (`stateChange` → `STARTED`, or [subscribeToBackendRestart]); whether a
 * mutation is safe to replay is the caller's judgement.
 */
export { RpcChannelClosedError } from "@comapeo/ipc/errors.js";

// Android only: transport-drop recovery in two phases. At drop time, fail
// every in-flight call now rather than at the 30s timeout. Project
// references stay valid across the drop — their channels are keyed by
// project public id, which a restarted server serves identically.
// Resubscription waits for recovery — the backend STARTED again AND the
// message socket reconnected — because resubscribing at drop time would
// nudge the native connect out of its terminal Error state in a tight loop
// while the backend stays down, and there is nothing to resubscribe to
// until a new server exists. Both recovery conditions are tracked
// separately: the lifecycle state comes from the control socket, which
// reconnects independently of the message socket the RPC traffic actually
// rides on.
let transportDropped = false;
let transportConnected = false;

/**
 * Boot nonce of the backend that was serving before the current drop (or is
 * serving now) — the last one observed OUTSIDE a recovery window. Compared
 * against the post-recovery nonce to tell an app-side reconnect (same
 * backend, same nonce — resubscribe only) from a genuine backend restart
 * (new process, new nonce — also fire restart listeners). Necessary because
 * the control server replays `started`/`ready` to late-connecting clients,
 * so state transitions alone can't make that distinction.
 */
let lastSeenBootNonce: string | null = null;

const restartListeners = new Set<() => void>();

function maybeCompleteRecovery() {
  if (!transportDropped || !transportConnected) return;
  if (nativeModule.getState() !== "STARTED") return;
  transportDropped = false;
  resubscribe(comapeo);
  resubscribe(comapeoServicesClient);

  const nonce = nativeModule.getBootNonce?.() ?? null;
  // No nonce (older backend/native) leaves restart vs. reconnect
  // undecidable; fire anyway — a spurious re-fetch is recoverable, caches
  // kept stale across a real restart are not. With a nonce, a first-ever
  // value is initial-boot completion, not a restart.
  const genuineRestart =
    nonce === null ? true : lastSeenBootNonce !== null && nonce !== lastSeenBootNonce;
  if (nonce !== null) lastSeenBootNonce = nonce;
  if (!genuineRestart) return;

  for (const listener of [...restartListeners]) {
    try {
      listener();
    } catch (err) {
      console.error("backend-restart listener threw", err);
    }
  }
}

// Optional calls, matching the other absent-native fallbacks (test contexts).
nativeModule.addListener?.(
  "transportStateChange",
  (event: TransportStateChangeEventPayload) => {
    if (event.state === "connected") {
      transportConnected = true;
      // Covers a message-socket-only drop: the control-socket state never
      // left STARTED, so no stateChange event will arrive to finish the job.
      maybeCompleteRecovery();
      return;
    }
    transportConnected = false;
    transportDropped = true;
    notifyTransportReset(comapeo);
    notifyTransportReset(comapeoServicesClient);
  },
);

nativeModule.addListener?.("stateChange", (event: StateChangeEventPayload) => {
  if (event.state !== "STARTED") return;
  maybeCompleteRecovery();
  // Normal-operation tracking. Skipped while a drop is still unrecovered
  // (`transportDropped` after the call above) so the pre-drop nonce stays
  // available for the restart comparison once the transport reconnects.
  if (event.bootNonce && !transportDropped) {
    lastSeenBootNonce = event.bootNonce;
  }
});

/**
 * Subscribe to backend restarts: fires once the backend is running again
 * (`STARTED`) AND the RPC transport has reconnected, after the transport
 * dropped mid-session — on Android that means the OS killed and restarted the
 * `:ComapeoCore` service while the app kept running. Never fires on iOS (the
 * backend is in-process there). A backend that was stopped deliberately and
 * later cold-started also fires this — the caches are equally stale there.
 *
 * Restart detection is nonce-based: the backend stamps its `ready` frame with
 * a per-process boot nonce, and listeners fire only when the post-recovery
 * nonce differs from the last-seen one. An app-side reconnect to a backend
 * that kept running (same nonce) resubscribes silently — no restart signal,
 * because nothing was lost server-side beyond per-connection subscriptions.
 *
 * By the time a listener fires, in-flight calls have been rejected with
 * [RpcChannelClosedError] and event subscriptions have been replayed to the
 * new backend. Project clients obtained via `getProject` before the restart
 * remain valid — their channels are keyed by project public id, which the
 * restarted server serves identically — but data fetched before the restart
 * may be stale. `@comapeo/core-react` re-fetches when wired up:
 *
 * ```tsx
 * <ComapeoCoreProvider
 *   clientApi={comapeo}
 *   subscribeToBackendRestart={subscribeToBackendRestart}
 * >
 * ```
 *
 * Returns an unsubscribe function.
 */
export function subscribeToBackendRestart(listener: () => void): () => void {
  restartListeners.add(listener);
  return () => {
    restartListeners.delete(listener);
  };
}
