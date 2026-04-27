import { NativeModule, requireNativeModule, EventEmitter } from "expo";
import { type JsonValue } from "type-fest";
import {
  ComapeoCoreModuleEvents,
  type MessageEventPayload,
} from "./ComapeoCore.types";
import { createMapeoClient, type MapeoClientApi } from "@comapeo/ipc/client.js";

declare class ComapeoCoreModule extends NativeModule<ComapeoCoreModuleEvents> {
  postMessage(value: string): void;
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
      console.error("Failed to parse message event data", event.data);
    }
  };

  addEventListener<EventName extends keyof MessagePortEvents>(
    eventName: EventName,
    listener: MessagePortEvents[EventName]
  ) {
    this.addListener(eventName, listener);
  }

  removeEventListener<EventName extends keyof MessagePortEvents>(
    eventName: EventName,
    listener: MessagePortEvents[EventName]
  ) {
    this.removeListener(eventName, listener);
  }
}

const messagePort = new CoreMessagePort() as unknown as MessagePort;
export const comapeo: MapeoClientApi = createMapeoClient(messagePort);
