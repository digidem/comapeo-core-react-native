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

const corePort = new CoreMessagePort();
const messagePort = corePort as unknown as MessagePort;
export const comapeo: MapeoClientApi = createMapeoClient(messagePort);

/**
 * Raw `CoreMessagePort` singleton — escape hatch for consumers that
 * need to bypass the `MapeoClient` request/response machinery and
 * speak directly to whatever backend bundle the consumer has wired in
 * (e.g. the bench app at `apps/benchmark/` overrides the entry via
 * `comapeoEntryFile` and talks to its own `BenchRpcServer`).
 *
 * `unstable_` prefix follows the React/RN convention for APIs whose
 * shape may change without notice — this port exposes the framing
 * layer one level below the public `comapeo` client and isn't part of
 * the supported surface. Production consumers should use `comapeo`.
 *
 * Note: `createMapeoClient(messagePort)` above already adds a
 * `"message"` listener to this port. Custom requests with a different
 * shape than `{ id, method, params }` are treated as unknown frames
 * by the prod RPC machinery and silently ignored.
 */
export const unstable_messagePort = corePort;

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
