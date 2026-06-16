import { Buffer } from "node:buffer";
import FramedStream from "framed-stream";
import ensureError from "ensure-error";

/**
 * @import {JsonValue} from "type-fest"
 * @import {MessagePortLike} from "rpc-reflector"
 */

const MESSAGE_PORT_EVENTS = /** @type {const} */ ([
  "message",
  "messageerror",
  "close",
]);

/**
 * @typedef {typeof MESSAGE_PORT_EVENTS[number]} MessagePortEventType
 */

/** @type {Event & { type: 'close' }} */
class MessagePortCloseEvent extends Event {
  constructor() {
    super("close");
  }
}

/**
 * @implements {MessagePortLike}
 */
export class SocketMessagePort {
  /** @type {'idle' | 'active' | 'closed'} */
  #state = "idle";
  #framedStream;
  /** @type {JsonValue[]} */
  #queue = [];
  #listeners = {
    /** @type {Set<(event: MessagePortCloseEvent) => void>} */
    close: new Set(),
    /** @type {Set<(event: MessageEvent) => void>} */
    message: new Set(),
    /** @type {Set<(event: MessageEvent) => void>} */
    messageerror: new Set(),
  };

  /** @param {Buffer} buf */
  #handleData = (buf) => {
    try {
      const message = JSON.parse(buf.toString());
      if (this.#state === "active") {
        this.dispatchEvent(new MessageEvent("message", { data: message }));
      } else if (this.#state === "idle") {
        this.#queue.push(message);
      }
    } catch (reason) {
      this.dispatchEvent(
        new MessageEvent("messageerror", { data: ensureError(reason) }),
      );
    }
  };

  /**
   * @param {NodeJS.ReadWriteStream} socket
   */
  constructor(socket) {
    this.#framedStream = new FramedStream(socket);
    this.#framedStream.on("data", this.#handleData);
    this.#framedStream.on("close", () => {
      this.#framedStream.off("data", this.#handleData);
      this.close();
    });
    this.#framedStream.on("error", (error) => {
      this.dispatchEvent(
        new MessageEvent("messageerror", { data: ensureError(error) }),
      );
    });
  }

  /**
   * @param {JsonValue} message
   */
  postMessage(message) {
    this.#framedStream.write(Buffer.from(JSON.stringify(message)));
  }

  start() {
    if (this.#state !== "idle") return;
    this.#state = "active";
    for (const message of this.#queue) {
      this.dispatchEvent(new MessageEvent("message", { data: message }));
    }
    this.#queue.length = 0;
  }

  /**
   * @overload
   * @param {'close'} event
   * @param {(event: MessagePortCloseEvent) => void} listener
   * @returns {void}
   */
  /**
   * @overload
   * @param {'message' | 'messageerror'} event
   * @param {(event: MessageEvent) => void} listener
   * @returns {void}
   */
  /**
   * @param {MessagePortEventType} type
   * @param {(event: MessageEvent & MessagePortCloseEvent) => void} listener
   */
  addEventListener(type, listener) {
    assertValidMessagePortEventType(type);
    this.#listeners[type].add(
      // @ts-expect-error TS can't infer the listener type based on event type
      listener,
    );
  }

  /**
   * @overload
   * @param {'close'} type
   * @param {(event: MessagePortCloseEvent) => void} listener
   * @returns {void}
   */
  /**
   * @overload
   * @param {'message' | 'messageerror'} type
   * @param {(event: MessageEvent) => void} listener
   * @returns {void}
   */
  /**
   * @param {MessagePortEventType} type
   * @param {(event: MessageEvent & MessagePortCloseEvent) => void} listener
   */
  removeEventListener(type, listener) {
    assertValidMessagePortEventType(type);
    this.#listeners[type].delete(
      // @ts-expect-error TS can't infer the listener type based on event type
      listener,
    );
  }

  /**
   * @param {MessageEvent | MessagePortCloseEvent} event
   */
  dispatchEvent(event) {
    assertValidMessagePortEventType(event.type);
    const listeners = this.#listeners[event.type];
    if (listeners) {
      for (const listener of listeners) {
        listener(
          // @ts-expect-error TS can't infer the listener type based on event type
          event,
        );
      }
    }
  }

  close() {
    if (this.#state === "closed") return;
    this.#state = "closed";
    this.#queue.length = 0;
    this.#framedStream.destroy();
    this.dispatchEvent(new MessagePortCloseEvent());
  }
}

/**
 * @param {string} type
 * @returns {asserts type is MessagePortEventType}
 */
const assertValidMessagePortEventType = (type) => {
  if (
    !MESSAGE_PORT_EVENTS.includes(/** @type {MessagePortEventType} */ (type))
  ) {
    throw new Error(`Invalid MessagePort event type: ${type}`);
  }
};
