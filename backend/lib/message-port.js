import { Buffer } from "node:buffer";
import FramedStream from "framed-stream";
import { TypedEmitter } from "tiny-typed-emitter";
import ensureError from "ensure-error";

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
 * @typedef {Pick<import('node:events').EventEmitter, 'addListener' | 'removeListener'> & { postMessage: (message: any) => void }} MessagePortLike
 */

/**
 * @extends {TypedEmitter<Events>}
 */
export class SocketMessagePort extends TypedEmitter {
  /** @type {'idle' | 'active' | 'closed'} */
  #state = "idle";
  #framedStream;
  /** @type {JsonValue[]} */
  #queue = [];

  /** @param {Buffer} buf */
  #handleData = (buf) => {
    try {
      const message = JSON.parse(buf.toString());
      if (this.#state === "active") {
        this.emit("message", message);
      } else if (this.#state === "idle") {
        this.#queue.push(message);
      }
    } catch (reason) {
      console.error("Failed to parse message", reason);
      this.emit("messageerror", ensureError(reason));
    }
  };

  /**
   * @param {NodeJS.ReadWriteStream} socket
   */
  constructor(socket) {
    super();
    this.#framedStream = new FramedStream(socket);
    this.#framedStream.on("data", this.#handleData);
    this.#framedStream.on("close", () => {
      this.#framedStream.off("data", this.#handleData);
      this.close();
    });
    this.#framedStream.on("error", (error) => {
      // TODO: Emit error, handle in consumer
      console.error("FramedStream error", error);
    });
    // The underlying AF_UNIX socket emits its own 'error' event for
    // events the framed-stream wrapper doesn't surface — most
    // importantly `ERR_STREAM_WRITE_AFTER_END` when a producer attempts
    // to post during the half-closed shutdown window. Without a
    // listener here, a stray write during graceful teardown bubbles to
    // `uncaughtException` and the process exits 1, even though the
    // shutdown was orderly. Log + swallow: the writer side already
    // detects close via `state === "closed"` (see `postMessage`) so a
    // socket-level error post-close has no further consequence.
    socket.on("error", (error) => {
      console.warn(
        "SocketMessagePort: underlying socket error",
        /** @type {NodeJS.ErrnoException} */ (error).code ?? error.message,
      );
    });
  }

  /**
   * @param {JsonValue} message
   */
  postMessage(message) {
    // Drop writes after close. AF_UNIX writes against an ended socket
    // raise `ERR_STREAM_WRITE_AFTER_END`; the natural shutdown race
    // (in-flight RPC response posted while the server is closing its
    // sockets) lands here. NOTE: this guard handles writes posted
    // AFTER close completes. Writes posted BEFORE close completes but
    // executed (via streamx's nextTick microtask) after the underlying
    // socket has ended end up throwing past this check; the host
    // process's `uncaughtException` handler must filter the resulting
    // `ERR_STREAM_WRITE_AFTER_END` during shutdown — see
    // `backend/index.bench.js`.
    if (this.#state === "closed") return;
    this.#framedStream.write(Buffer.from(JSON.stringify(message)));
  }

  start() {
    if (this.#state !== "idle") return;
    this.#state = "active";
    for (const message of this.#queue) {
      this.emit("message", message);
    }
    this.#queue.length = 0;
  }

  /**
   * @template {keyof Events} TEvent
   * @param {TEvent} event
   * @param {Events[TEvent]} listener
   */
  addEventListener(event, listener) {
    this.addListener(event, listener);
  }
  /**
   * @template {keyof Events} TEvent
   * @param {TEvent} event
   * @param {Events[TEvent]} listener
   */
  removeEventListener(event, listener) {
    this.removeListener(event, listener);
  }

  close() {
    if (this.#state === "closed") return;
    this.#state = "closed";
    this.#queue.length = 0;
    this.#framedStream.destroy();
  }
}
