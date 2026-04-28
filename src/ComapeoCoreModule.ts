import { NativeModule, requireNativeModule, EventEmitter } from "expo";
import { type JsonValue } from "type-fest";
import {
  ComapeoCoreModuleEvents,
  type ComapeoState,
  type MessageEventPayload,
  type StateChangeEventPayload,
} from "./ComapeoCore.types";
import { createMapeoClient, type MapeoClientApi } from "@comapeo/ipc/client.js";

declare class ComapeoCoreModule extends NativeModule<ComapeoCoreModuleEvents> {
  postMessage(value: string): void;
  getState(): ComapeoState;
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
export const comapeo: MapeoClientApi = createMapeoClient(messagePort);

type StateEvents = {
  stateChange: (state: ComapeoState) => void;
};

/**
 * JS-facing observer for the embedded service's lifecycle. Mirrors the
 * `comapeo` MessagePort surface: `getState()` for a one-shot read,
 * `addListener("stateChange", ...)` for push notifications.
 *
 * State transitions are sourced from the native module's `stateChange`
 * event. iOS derives this from the in-process `NodeJSService.onStateChange`
 * callback. Android derives it from the control-socket messages
 * (`started`/`ready`) plus the IPC's connection-state stream.
 */
class State extends EventEmitter<StateEvents> {
  getState(): ComapeoState {
    return nativeModule.getState();
  }

  startObserving<EventName extends keyof StateEvents>(eventName: EventName): void {
    if (eventName !== "stateChange") return;
    nativeModule.addListener("stateChange", this.#handleStateChangeEvent);
  }

  stopObserving<EventName extends keyof StateEvents>(eventName: EventName): void {
    if (eventName !== "stateChange") return;
    nativeModule.removeListener("stateChange", this.#handleStateChangeEvent);
  }

  #handleStateChangeEvent = (event: StateChangeEventPayload) => {
    this.emit("stateChange", event.state);
  };
}

export const state = new State();
