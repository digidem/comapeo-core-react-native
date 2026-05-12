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
import { createMapeoClient, type MapeoClientApi } from "@comapeo/ipc/client.js";
import { activeAdapter } from "./sentry-internal";
import type { SentryInitConfig } from "./sentry";

declare class ComapeoCoreModule extends NativeModule<ComapeoCoreModuleEvents> {
  postMessage(value: string): void;
  getState(): ComapeoState;
  getLastError(): ComapeoErrorInfo | null;
  /**
   * Sentry options the Expo plugin baked into the native config.
   * Empty object when the plugin isn't registered (or DSN absent).
   */
  readonly sentryConfig: SentryInitConfig;
}

// This call loads the native module object from the JSI.
const nativeModule = requireNativeModule<ComapeoCoreModule>("ComapeoCore");

/**
 * Sentry options baked into the native config by the Expo plugin.
 * Re-exported as `sentryConfig` from the `/sentry` sub-export.
 *
 * Always-defined: an empty object when the plugin isn't registered,
 * so `Sentry.init({ ...sentryConfig, ...mine })` is always safe.
 */
export function readSentryConfig(): SentryInitConfig {
  return nativeModule.sentryConfig ?? {};
}

type MessagePortEvents = {
  message: (message: JsonValue) => void;
};

class CoreMessagePort extends EventEmitter<MessagePortEvents> {
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
      this.emit("message", message);
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

const messagePort = new CoreMessagePort() as unknown as MessagePort;

const noop = () => {};

// RPC client tracing. Registered unconditionally so consumers that
// imported `comapeo` before the `/sentry` sub-export's side effects
// ran still get traced; the `!parentSpan` short-circuit is the no-op
// path. The trace headers it injects on `request.metadata` are
// consumed by `backend/lib/comapeo-rpc.js`.
export const comapeo: MapeoClientApi = createMapeoClient(messagePort, {
  onRequestHook: (request, next) => {
    const adapter = activeAdapter();
    const parentSpan = adapter?.getActiveSpan();
    if (!adapter || !parentSpan) {
      next(request).catch(noop);
      return;
    }
    adapter.startSpan(
      { name: request.method.join("."), op: "ipc" },
      async (span) => {
        const traceData = adapter.getTraceData({ span });
        if (traceData["sentry-trace"]) {
          // `metadata` isn't in @comapeo/ipc's request type yet.
          (request as unknown as { metadata?: Record<string, string> }).metadata = {
            "sentry-trace": traceData["sentry-trace"],
            baggage: traceData["baggage"] ?? "",
          };
        }
        try {
          await next(request);
          span.setStatus?.({ code: 1, message: "ok" });
        } catch (error) {
          span.setStatus?.({ code: 2, message: "internal_error" });
          adapter.captureException(error);
        }
      },
    );
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

  startObserving<EventName extends keyof StateEvents>(eventName: EventName): void {
    if (eventName === "stateChange") {
      nativeModule.addListener("stateChange", this.#handleStateChangeEvent);
    } else if (eventName === "messageerror") {
      nativeModule.addListener("messageerror", this.#handleMessageErrorEvent);
    }
  }

  stopObserving<EventName extends keyof StateEvents>(eventName: EventName): void {
    if (eventName === "stateChange") {
      nativeModule.removeListener("stateChange", this.#handleStateChangeEvent);
    } else if (eventName === "messageerror") {
      nativeModule.removeListener("messageerror", this.#handleMessageErrorEvent);
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
