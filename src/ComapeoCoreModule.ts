import { NativeModule, requireNativeModule, EventEmitter } from "expo";
import { type JsonValue } from "type-fest";
import {
  ComapeoCoreModuleEvents,
  type MessageEventPayload,
  type StateChangeEventPayload,
} from "./ComapeoCore.types";

declare class ComapeoCoreModule extends NativeModule<ComapeoCoreModuleEvents> {
  postMessage(value: string): void;
}

// This call loads the native module object from the JSI.
const nativeModule = requireNativeModule<ComapeoCoreModule>("ComapeoCore");

type MessagePortEvents = {
  message: (message: JsonValue) => void;
};

type StateChangeEvents = {
  stateChange: (state: string) => void;
};

class State extends EventEmitter<StateChangeEvents> {
  getState() {
    return nativeModule.getState();
  }

  startObserving(eventName: keyof StateChangeEvents): void {
    // eslint-disable-next-line no-useless-return
    if (eventName !== "stateChange") return;
    nativeModule.addListener(eventName, this.#handleStateChangeEvent);
  }

  stopObserving(eventName: keyof StateChangeEvents): void {
    // eslint-disable-next-line no-useless-return
    if (eventName !== "stateChange") return;
    nativeModule.removeListener(eventName, this.#handleStateChangeEvent);
  }

  #handleStateChangeEvent = (event: StateChangeEventPayload) => {
    this.emit("stateChange", event.state);
  };
}

class MessagePort extends EventEmitter<MessagePortEvents> {
  postMessage(value: JsonValue) {
    nativeModule.postMessage(JSON.stringify(value));
  }
  startObserving<EventName extends keyof ComapeoCoreModuleEvents>(
    eventName: EventName
  ): void {
    // eslint-disable-next-line no-useless-return
    if (eventName !== "message") return;
    nativeModule.addListener(eventName as "message", this.#handleMessageEvent);
  }

  stopObserving<EventName extends keyof ComapeoCoreModuleEvents>(
    eventName: EventName
  ): void {
    // eslint-disable-next-line no-useless-return
    if (eventName !== "message") return;
    nativeModule.removeListener(
      eventName as "message",
      this.#handleMessageEvent
    );
  }

  #handleMessageEvent = (event: MessageEventPayload) => {
    try {
      const message = JSON.parse(event.data);
      this.emit("message", message);
    } catch {
      // ignore
    }
  };
}

export const messagePort = new MessagePort();
export const state = new State();
