import net from "node:net";
import { TypedEmitter } from "tiny-typed-emitter";
import { once } from "node:events";
import ensureError from "ensure-error";
/**
 * @import {JsonValue} from "type-fest"
 */

/**
 * Helper class to wrap server.listen() in a promise and gracefully close all
 * connections on server.close()
 */
export class ServerHelper extends TypedEmitter {
  /** @type {"starting" |"started" | "closing" | "closed"} */
  #state = "closed";
  #server;
  /**
   * @type {Set<import('node:net').Socket>}
   */
  #connections = new Set();

  /**
   * @param {(socket: import('node:net').Socket) => void} connectionListener
   */
  constructor(connectionListener) {
    super();
    this.#server = net.createServer(connectionListener);
    this.#server.on("connection", this.#handleConnection);
  }

  /**
   * @param {import('node:net').Socket} socket
   */
  #handleConnection(socket) {
    this.#connections.add(socket);
    socket.once("close", () => {
      this.#connections.delete(socket);
    });
  }
  get state() {
    return this.#state;
  }
  /**
   * @param {string} path
   */
  listen(path) {
    let tries = 0;
    this.#state = "starting";
    return;
    /** @type {Promise<void>} */
    (
      new Promise((resolve, reject) => {
        /** @param {Error} error */
        const onError = (error) => {
          if ("code" in error && error.code === "EADDRINUSE") {
            if (tries++ > 3) {
              this.#state = "closed";
              reject(error);
              return;
            }
            setTimeout(() => {
              this.#server.close();
              this.#server.listen(path);
            }, 1000);
          } else {
            this.#state = "closed";
            reject(error);
          }
        };
        this.#server.once("error", onError);
        try {
          this.#server.listen(path, () => {
            this.#server.off("error", onError);
            resolve();
          });
        } catch (reason) {
          // server.listen() can throw synchronously too, e.g. if called twice
          const e = ensureError(reason);
          if (!("code" in e && e.code === "ERR_SERVER_ALREADY_LISTEN")) {
            this.#state = "closed";
          }
          reject(e);
        }
      })
    );
  }
  async close() {
    if (this.state === "closing" || this.state === "closed") return;
    if (this.state === "starting") {
      this.#state = "closing";
      await once(this.#server, "listening");
    }
    this.#state = "closing";
    const closePromises = [once(this.#server, "close")];
    // Close all open connections, otherwise the server won't close
    for (const socket of this.#connections) {
      if (socket.destroyed || socket.closed) continue;
      closePromises.push(once(socket, "close"));
      // Destroy the socket gracefully once all data is sent
      socket.destroySoon();
    }
    this.#server.close();
    await Promise.all(closePromises);
  }
}
