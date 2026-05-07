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

declare class ComapeoCoreModule extends NativeModule<ComapeoCoreModuleEvents> {
  postMessage(value: string): void;
  getState(): ComapeoState;
  getLastError(): ComapeoErrorInfo | null;
}

// This call loads the native module object from the JSI.
const nativeModule = requireNativeModule<ComapeoCoreModule>("ComapeoCore");

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

/**
 * RPC client tracing hook. Mirrors comapeo-mobile's
 * `createMapeoApi.ts`. Inert when no Sentry adapter is registered
 * (i.e. consumer didn't import `@comapeo/core-react-native/sentry`)
 * or when there's no active root span (tracing disabled / no parent).
 *
 * Registered unconditionally because `comapeo` is a module-scoped
 * const — consumers may have imported and called methods before
 * the sub-export's side effects run. The `!parentSpan` short-circuit
 * is the no-op path; it costs one function call and one falsy check.
 *
 * `getTraceData` propagates the `sentry-trace`/`baggage` headers
 * via the request's metadata, which the backend's `onRequestHook`
 * (`backend/lib/comapeo-rpc.js`) reads via `Sentry.continueTrace`
 * to make the backend RPC span a child of the JS-side IPC span.
 */
export const comapeo: MapeoClientApi = createMapeoClient(messagePort, {
  onRequestHook: (request, next) => {
    const adapter = activeAdapter();
    const parentSpan = adapter?.getActiveSpan();
    if (!adapter || !parentSpan) {
      // Tracing disabled (no sub-export imported, or no active root
      // span) — pass through with no metadata injection. `noop` on
      // the catch matches comapeo-mobile and prevents an unhandled
      // rejection when the IPC layer rejects (the IPC client itself
      // already rejects the caller's promise; we just need to swallow
      // here so this hook's return doesn't surface a duplicate).
      next(request).catch(noop);
      return;
    }
    adapter.startSpan(
      { name: request.method.join("."), op: "ipc" },
      async (span) => {
        const traceData = adapter.getTraceData({ span });
        if (traceData["sentry-trace"]) {
          // `request.metadata` isn't in @comapeo/ipc's request type
          // yet — forward-compat field consumed by the backend's
          // `onRequestHook` (`backend/lib/comapeo-rpc.js`).
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
