import { ServerHelper } from "./server-helper.js";
import { SocketMessagePort } from "./message-port.js";

/**
 * A simple RPC server that listens for messages and calls methods based on message type.
 * @template {Record<string, (...args: any[]) => any>} TMethods
 */
export class SimpleRpcServer extends ServerHelper {
  #methods;
  /**
   * @param {TMethods} methods
   */
  constructor(methods) {
    super((socket) => {
      const messagePort = new SocketMessagePort(socket);
      messagePort.on("message", this.#handleMessage);
      messagePort.on("messageerror", (error) => {
        console.error("Client sent invalid message", error);
      });
      messagePort.start();
    });
    this.#methods = methods;
  }

  /**
   * @param {import("type-fest").JsonValue} message
   */
  #handleMessage(message) {
    if (
      !message ||
      typeof message !== "object" ||
      !("type" in message) ||
      typeof message.type !== "string" ||
      !(message.type in this.#methods)
    ) {
      console.warn("Received invalid message", message);
      return;
    }
    this.#methods[message.type]();
  }
}
