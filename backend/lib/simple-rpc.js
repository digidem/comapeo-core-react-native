import { ServerHelper } from "./server-helper.js";
import { SocketMessagePort } from "./message-port.js";
import * as metrics from "./metrics.js";

/**
 * @typedef {{ type: "stopping" } | { type: "error", phase: string, message: string, stack?: string }} TerminalFrame
 */

/**
 * @typedef {{ type: "migrating", context: string } |
 *   { type: "migration-error", error: string, stack?: string } |
 *   { type: "low-space", spaceNeeded?: string } } TransientFrame
 */

/**
 * Control-socket server. Routes inbound requests by `type`, broadcasts
 * lifecycle transitions, and replays them so late-connecting clients
 * converge on the same state.
 *
 * Readiness phases: `pre-listening` → `started` (socket bound, awaiting
 * `init` from native) → `ready` (manager built, RPC socket bound).
 *
 * Transient states: `migrating`, `migration-error`, and `low-space` frames
 * are non-terminal (native recovers via a `retry` frame), but a
 * late-connecting client would otherwise converge on `started` while the
 * backend sits in a migration state. The latest such frame is replayed on
 * connect. `migration-error` is preceded by a synthetic `migrating` frame
 * (matching the live path, which always sends one first); `low-space` is
 * not, since the live `low-space` path skips the `migrating` frame.
 *
 * Method handlers receive the full message so they can read fields
 * beyond `type` (e.g. `init.rootKey`).
 *
 * @template {Record<string, (message: any) => any>} TMethods
 */
export class SimpleRpcServer extends ServerHelper {
  #methods;
  /** @type {Set<SocketMessagePort>} */
  #clients = new Set();
  /** @type {"pre-listening" | "started" | "ready"} */
  #readinessPhase = "pre-listening";
  /** @type {TerminalFrame | null} */
  #terminalFrame = null;
  /** @type {TransientFrame | null} */
  #activeTransientState = null;
  // Replayed on every connect: on Android both FGS and main-app
  // connect, only FGS owns sentry-android, and connect order isn't
  // guaranteed — replay-once would lose frames on a bad ordering.
  // Sentry dedupes FGS reconnect duplicates by event_id.
  /** @type {import("type-fest").JsonObject[]} */
  #recentSentryFrames = [];
  static #MAX_RECENT_SENTRY_FRAMES = 100;

  /**
   * @param {TMethods} methods
   */
  constructor(methods) {
    super((socket) => this.#onConnection(socket));
    this.#methods = methods;
  }

  /** @param {import('node:net').Socket} socket */
  #onConnection(socket) {
    const messagePort = new SocketMessagePort(socket);
    messagePort.addEventListener("message", this.#handleMessageEvent);
    messagePort.addEventListener("messageerror", (event) => {
      // Log the error NAME only, never the message: V8's JSON.parse
      // SyntaxError embeds a snippet of the raw input, and a mangled init
      // frame would put rootKey bytes in it.
      console.error("Client sent invalid message", event.data?.name);
      metrics.ipcError(event.data?.name);
    });
    messagePort.addEventListener("close", () => {
      this.#clients.delete(messagePort);
    });
    this.#clients.add(messagePort);
    messagePort.start();

    if (
      this.#readinessPhase === "started" ||
      this.#readinessPhase === "ready"
    ) {
      messagePort.postMessage({ type: "started" });
    }
    if (this.#readinessPhase === "ready") {
      messagePort.postMessage({ type: "ready" });
    }
    // A terminal frame supersedes any transient state (`ready` clears it
    // in setReadinessPhase), so replay the transient only when no
    // terminal frame will follow it.
    if (this.#terminalFrame === null && this.#activeTransientState !== null) {
      if (this.#activeTransientState.type === "migration-error") {
        // The live path always sends a `migrating` frame before
        // `migration-error` (inside the `shouldUpgrade` branch), so a
        // late-connecting client needs the transition replayed too.
        // (`low-space` has no preceding `migrating` in the live path,
        // so no synthetic frame is injected for it.)
        messagePort.postMessage({ type: "migrating", context: "1/2" });
      }
      messagePort.postMessage(this.#activeTransientState);
    }
    if (this.#terminalFrame !== null) {
      messagePort.postMessage(this.#terminalFrame);
    }
    for (const frame of this.#recentSentryFrames) {
      messagePort.postMessage(frame);
    }
  }

  /**
   * @param {MessageEvent} event
   */
  #handleMessageEvent = ({ data: message }) => {
    if (
      !message ||
      typeof message !== "object" ||
      !("type" in message) ||
      typeof message.type !== "string" ||
      !(message.type in this.#methods)
    ) {
      // Log the routing field only, never the payload: the init frame
      // carries the rootKey, and this socket is where it travels.
      console.warn(
        "Received invalid message",
        message && typeof message === "object" && typeof message.type === "string"
          ? `type=${message.type}`
          : typeof message,
      );
      return;
    }
    const method = this.#methods[message.type];
    if (typeof method !== "function") {
      console.warn("Handler for message type is not a function", message.type);
      return;
    }
    method(message);
  };

  /**
   * Idempotent. Throws on out-of-order `ready` so late clients don't
   * see `ready` without a prior `started`.
   *
   * @param {"started" | "ready"} phase
   */
  setReadinessPhase(phase) {
    if (this.#readinessPhase === phase) return;
    if (phase === "ready" && this.#readinessPhase !== "started") {
      throw new Error(
        `Cannot transition to "ready" from "${this.#readinessPhase}"`,
      );
    }
    this.#readinessPhase = phase;
    if (phase === "ready") {
      // Boot finished or a retry succeeded: the migration state no
      // longer exists to converge on.
      this.#activeTransientState = null;
    }
    for (const client of this.#clients) {
      client.postMessage({ type: phase });
    }
  }

  get readinessPhase() {
    return this.#readinessPhase;
  }

  /** @returns {TransientFrame | null} */
  get activeTransientState() {
    return this.#activeTransientState;
  }

  /** @param {TerminalFrame | { type: string } & import("type-fest").JsonObject} message */
  broadcast(message) {
    if (message.type === "stopping" || message.type === "error") {
      this.#terminalFrame = /** @type {TerminalFrame} */ (message);
      // Terminal wins: no transient state survives a shutdown or fatal.
      this.#activeTransientState = null;
    } else if (
      message.type === "migrating" ||
      message.type === "migration-error" ||
      message.type === "low-space"
    ) {
      this.#activeTransientState = /** @type {TransientFrame} */ (message);
    }
    if (message.type === "sentry-event" || message.type === "sentry-envelope") {
      if (
        this.#recentSentryFrames.length >=
        SimpleRpcServer.#MAX_RECENT_SENTRY_FRAMES
      ) {
        this.#recentSentryFrames.shift();
      }
      this.#recentSentryFrames.push(
        /** @type {import("type-fest").JsonObject} */ (message),
      );
    }
    for (const client of this.#clients) {
      try {
        client.postMessage(message);
      } catch (e) {
        console.error("broadcast: client postMessage threw", e);
        metrics.ipcError(e instanceof Error ? e.name : undefined);
      }
    }
  }

  /**
   * Flush every client before the sockets go away: `broadcast()` only queues
   * the frame, and `super.close()` destroys the socket under it.
   *
   * @override
   */
  async close() {
    await Promise.all(
      [...this.#clients].map((client) =>
        client.drained().catch((e) => {
          console.error("close: client drain failed", e);
        }),
      ),
    );
    await super.close();
  }
}
