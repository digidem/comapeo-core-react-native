import { createServer } from "rpc-reflector/server.js";

/** @import {MessagePortLike, MessageEvent} from 'rpc-reflector' */
/** @import {MapeoManager} from '@comapeo/core' */

// Deliberately OUTSIDE @comapeo/ipc's `@@comapeo/` prefix: its server routes
// only ids carrying its own prefix and silently ignores foreign ones, so
// these frames coexist on the message socket without the production router
// ever seeing them — and a production build (flag unset) ignores the id the
// same way, leaving debug-client calls to time out.
export const DEBUG_LIFECYCLE_CHANNEL_ID = "@@comapeo-debug/lifecycle";

/**
 * Minimal sub-channel over a shared message port: wraps outbound messages as
 * `{ id, message }` and unwraps inbound ones with a matching `id`.
 * Same wire shape as @comapeo/ipc's internal SubChannel (not exported from
 * that package). No pre-start queue: the server side attaches before the
 * port starts, and the client side only cares about replies to its own
 * requests.
 *
 * @implements {MessagePortLike}
 */
export class DebugSubChannel {
  #id;
  #messagePort;
  /** @type {Set<(event: MessageEvent) => void>} */
  #listeners = new Set();

  /**
   * @param {MessagePortLike} messagePort
   * @param {string} id
   */
  constructor(messagePort, id) {
    this.#id = id;
    this.#messagePort = messagePort;
    this.#messagePort.addEventListener("message", this.#handleMessageEvent);
  }

  /** @param {{ data: unknown }} event */
  #handleMessageEvent = ({ data }) => {
    if (!data || typeof data !== "object") return;
    const { id, message } = /** @type {{ id?: unknown, message?: unknown }} */ (
      data
    );
    if (id !== this.#id) return;
    for (const listener of this.#listeners) {
      listener({ data: message });
    }
  };

  /**
   * @param {'message'} type
   * @param {(event: MessageEvent) => void} listener
   */
  addEventListener(type, listener) {
    if (type !== "message") return;
    this.#listeners.add(listener);
  }

  /**
   * @param {'message'} type
   * @param {(event: MessageEvent) => void} listener
   */
  removeEventListener(type, listener) {
    if (type !== "message") return;
    this.#listeners.delete(listener);
  }

  /** @param {unknown} message */
  postMessage(message) {
    this.#messagePort.postMessage({ id: this.#id, message });
  }

  close() {
    this.#listeners.clear();
    this.#messagePort.removeEventListener("message", this.#handleMessageEvent);
  }
}

/**
 * Debug-only lifecycle controls for e2e tests, served per connection on the
 * message socket. Lets a test trigger a *backend-side* project close — the
 * v10 contract the e2e suite verifies is that client calls transparently
 * survive one. Must only be served when the debug flag is set (see
 * `backend/index.js`); there is nothing here a production client should
 * reach.
 *
 * @param {MapeoManager} comapeoManager
 * @param {MessagePortLike} messagePort
 * @returns {{ close: () => void }}
 */
export function serveDebugLifecycle(comapeoManager, messagePort) {
  const channel = new DebugSubChannel(messagePort, DEBUG_LIFECYCLE_CHANNEL_ID);
  const server = createServer(
    {
      /**
       * Close the server-side project instance, as core would for its own
       * reasons (resource policy, re-invite cleanup). The next client call
       * on the project's channel re-opens it transparently.
       *
       * @param {string} projectPublicId
       */
      async closeProject(projectPublicId) {
        const project = await comapeoManager.getProject(projectPublicId);
        await project.close();
      },
    },
    channel,
  );
  return {
    close: () => {
      server.close();
      channel.close();
    },
  };
}
