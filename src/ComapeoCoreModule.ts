import { NativeModule, requireNativeModule, EventEmitter } from "expo";
import { type JsonValue } from "type-fest";
import {
  ComapeoCoreModuleEvents,
  type ComapeoErrorInfo,
  type ComapeoState,
  type MessageErrorEventPayload,
  type MessageEventPayload,
  type StateChangeEventPayload,
} from "./ComapeoCore.types";
import type { MessagePortLike } from "rpc-reflector";
import {
  AppRpcApi,
  createAppRpcClient,
  createMapeoClient,
  type MapeoClientApi,
} from "@comapeo/ipc/client.js";
import * as Sentry from "@sentry/react-native";
// `getTraceData` / `startNewTrace` aren't re-exported from
// `@sentry/react-native@7`; `@sentry/core` is a direct dep of RN so
// the import is safe.
import { getTraceData, startNewTrace } from "@sentry/core";
import type { SentryInitConfig } from "./sentry";

// `onRequestHook` request type derived from `createMapeoClient` so
// any hook-signature change up-stream is a compile error here. The
// hook input omits `metadata`; we re-add it to write into `next(...)`.
type IpcHookRequest = Parameters<
  NonNullable<
    NonNullable<Parameters<typeof createMapeoClient>[1]>["onRequestHook"]
  >
>[0];
type IpcRequestWithMetadata = IpcHookRequest & {
  metadata?: Record<string, string>;
};

/**
 * User-persisted sentry preferences (snapshot at module construction).
 * Diagnostics on by default; capture-app-data off by default. Plugin
 * `diagnosticsEnabledDefault` / `captureApplicationDataDefault` change
 * the fresh-install defaults but not the user's saved choice.
 */
export type SentryPreferences = {
  diagnosticsEnabled: boolean;
  captureApplicationData: boolean;
};

declare class ComapeoCoreModule extends NativeModule<ComapeoCoreModuleEvents> {
  postMessage(value: string): void;
  getState(): ComapeoState;
  getLastError(): ComapeoErrorInfo | null;
  /**
   * Sentry options the Expo plugin baked into the native config.
   * Empty object when the plugin isn't registered (or DSN absent).
   */
  readonly sentryConfig: SentryInitConfig;
  /**
   * User-persisted preferences, read at module construction.
   * Snapshot-at-boot — `setDiagnosticsEnabled` / `setCaptureApplicationData`
   * writes only take effect on the next launch.
   */
  readonly sentryPreferences: SentryPreferences;
  /**
   * Persist `diagnosticsEnabled` and (on a transition to false) wipe
   * the on-disk Sentry envelope cache so queued events from the
   * current session never ship. Restart-to-activate: the current
   * process keeps emitting until the next launch.
   */
  setDiagnosticsEnabled(value: boolean): Promise<void>;
  /**
   * Same shape as `setDiagnosticsEnabled` but for the
   * `captureApplicationData` toggle. Outbox wipe on false is full
   * (not just trace envelopes) — selective wipe would be a lot of
   * code for the same effect when an outbox is mixed.
   */
  setCaptureApplicationData(value: boolean): Promise<void>;
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
 * User-persisted sentry preferences. Snapshot-at-boot: the values are
 * read at native module construction, so `setDiagnosticsEnabled` /
 * `setCaptureApplicationData` writes only take effect on the next
 * launch. Falls back to safe defaults (diagnostics on, capture-app-
 * data off) when the native module isn't available (test contexts).
 */
export function readSentryPreferences(): SentryPreferences {
  return (
    nativeModule.sentryPreferences ?? {
      diagnosticsEnabled: true,
      captureApplicationData: false,
    }
  );
}

/** Persist `diagnosticsEnabled`. See `setDiagnosticsEnabled` JSDoc. */
export function setDiagnosticsEnabledNative(value: boolean): Promise<void> {
  return nativeModule.setDiagnosticsEnabled(value);
}

/** Persist `captureApplicationData`. See `setCaptureApplicationData` JSDoc. */
export function setCaptureApplicationDataNative(value: boolean): Promise<void> {
  return nativeModule.setCaptureApplicationData(value);
}

type MessagePortEvents = {
  message: (event: { data: JsonValue }) => void;
};

class CoreMessagePort implements MessagePortLike {
  #emitter = new EventEmitter<MessagePortEvents>();

  postMessage(value: JsonValue) {
    nativeModule.postMessage(JSON.stringify(value));
  }

  startObserving<EventName extends keyof ComapeoCoreModuleEvents>(
    eventName: EventName,
  ): void {
    if (eventName === "message") {
      nativeModule.addListener("message", this.#handleMessageEvent);
    }
  }

  stopObserving<EventName extends keyof ComapeoCoreModuleEvents>(
    eventName: EventName,
  ): void {
    if (eventName === "message") {
      nativeModule.removeListener("message", this.#handleMessageEvent);
    }
  }

  #handleMessageEvent = (event: MessageEventPayload) => {
    try {
      const message = JSON.parse(event.data);
      this.#emitter.emit("message", { data: message });
    } catch {
      console.error("Failed to parse message event data", event.data);
    }
  };

  addEventListener<EventName extends keyof MessagePortEvents>(
    eventName: EventName,
    listener: MessagePortEvents[EventName],
  ) {
    this.#emitter.addListener(eventName, listener);
  }

  removeEventListener<EventName extends keyof MessagePortEvents>(
    eventName: EventName,
    listener: MessagePortEvents[EventName],
  ) {
    this.#emitter.removeListener(eventName, listener);
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

export const comapeo: MapeoClientApi = createMapeoClient(messagePort, {
  timeout: RPC_TIMEOUT_MS,
  onRequestHook: (request, next) => {
    // Sentry-not-initialised guard. `isInitialized` lives in `@sentry/core`
    // and is reachable through the namespace at runtime but isn't on the
    // public type surface — defensive accessor in case the helper isn't
    // wired through in older SDK releases. Don't gate on `getActiveSpan`:
    // it's undefined whenever no transaction is in progress (e.g. after
    // App Start ends), which is exactly when we still want to create the
    // span and propagate the trace to the backend.
    const isInitialized = (
      Sentry as unknown as {
        isInitialized?: () => boolean;
      }
    ).isInitialized;
    if (typeof isInitialized === "function" && !isInitialized()) {
      next(request).catch(noop);
      return;
    }
    const method = request.method.join(".");
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
          try {
            // Split the span duration into "sync send" (JSI hop + UDS write
            // to Node) and "await" (entire round-trip incl. response delivery
            // back to the JS thread). If the gap between this span and the
            // Node-side rpc span is dominated by JS-thread contention on
            // cold boot, `rn.send.syncMs` stays small while total stays high.
            const sendStart = performance.now();
            const responsePromise = next(tracedRequest);
            span.setAttribute?.(
              "rn.send.syncMs",
              performance.now() - sendStart,
            );
            await responsePromise;
            span.setStatus?.({ code: 1, message: "ok" });
          } catch (error) {
            span.setStatus?.({ code: 2, message: "internal_error" });
            Sentry.captureException(error);
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
});

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

export const appRpcClient: AppRpcApi = createAppRpcClient(messagePort, {
  timeout: RPC_TIMEOUT_MS,
});
