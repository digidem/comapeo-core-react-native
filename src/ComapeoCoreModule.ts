import { NativeModule, requireNativeModule, EventEmitter } from "expo";
import { type JsonValue } from "type-fest";
import {
  ComapeoCoreModuleEvents,
  type MessageEventPayload,
} from "./ComapeoCore.types";

declare class ComapeoCoreModule extends NativeModule<ComapeoCoreModuleEvents> {
  postMessage(value: string): void;
}

// This call loads the native module object from the JSI.
const nativeModule = requireNativeModule<ComapeoCoreModule>("ComapeoCore");

type MessagePortEvents = {
  message: (message: JsonValue) => void;
};

class MessagePort extends EventEmitter<MessagePortEvents> {
  postMessage(value: JsonValue) {
    nativeModule.postMessage(JSON.stringify(value));
  }
  startObserving<EventName extends keyof ComapeoCoreModuleEvents>(
    eventName: EventName
  ): void {
    // eslint-disable-next-line no-useless-return
    if (eventName !== "message") return;
    nativeModule.addListener(eventName, this.#handleMessageEvent);
  }

  stopObserving<EventName extends keyof ComapeoCoreModuleEvents>(
    eventName: EventName
  ): void {
    // eslint-disable-next-line no-useless-return
    if (eventName !== "message") return;
    nativeModule.removeListener(eventName, this.#handleMessageEvent);
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

export default new MessagePort();
