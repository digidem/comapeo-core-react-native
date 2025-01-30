import {Buffer} from "node:buffer";
import FramedStream from "framed-stream";
import { TypedEmitter } from "tiny-typed-emitter";
import ensureError  from "ensure-error";

/**
 * @import {JsonValue} from "type-fest"
 */

/**
 * @typedef {Object} Events
 * @property {(message: JsonValue) => void} message
 * @property {(error: Error) => void} messageerror
 * @property {() => void} close
 */

/**
 * Node's built-in types for MessagePort are misleading so we opt for this limited type definition
 * that fits our usage and works in both Node and browser contexts
 * @typedef {Pick<EventTarget, 'addEventListener' | 'removeEventListener'> & { postMessage: (message: any) => void }} MessagePortLike
 */

/**
 * @extends {TypedEmitter<Events>}
 */
export class SocketMessagePort extends TypedEmitter {
  /** @type {'idle' | 'active' | 'closed'} */
  #state = "idle"
  #framedStream

  /** @param {Buffer} buf */
  #handleData = (buf) => {
    if (this.#state !== 'active') return // should not happen but just in case
    try {
      const message = JSON.parse(buf.toString())
      this.emit('message', message)
    } catch (reason) {
      console.error("Failed to parse message", reason)
      this.emit('messageerror', ensureError(reason))
    }
  }

  /**
   * @param {NodeJS.ReadWriteStream} socket
   */
  constructor(socket) {
    super()

    this.#framedStream = new FramedStream(socket);
    this.#framedStream.on("close", () => {
      this.close()
    });
    this.#framedStream.on("error", (error) => {
      this.emit('messageerror', ensureError(error))
    })
  }

  /**
   * Send messages with the subchannel's ID
   * @param {JsonValue} message
   */
  postMessage(message) {
    this.#framedStream.write(Buffer.from(JSON.stringify(message)))
  }

  start() {
    if (this.#state !== 'idle') return
    this.#state = 'active'
    this.#framedStream.on("data", this.#handleData);
  }

  close() {
    if (this.#state === 'closed') return
    this.#state = 'closed'
    this.#framedStream.off("data", this.#handleData);
  }
}
