import { ServerHelper } from "./server-helper.js";
import { SocketMessagePort } from "./message-port.js";
import * as metrics from "./metrics.js";

/**
 * @typedef {{ type: "stopping" } | { type: "error", phase: string, message: string, stack?: string }} TerminalFrame
 */

/**
 * Control-socket server. Routes inbound requests by `type`, broadcasts
 * lifecycle transitions, and replays them so late-connecting clients
 * converge on the same state.
 *
 * Readiness phases: `pre-listening` → `started` (socket bound, awaiting
 * `init` from native) → `ready` (manager built, RPC socket bound).
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
      console.error("Client sent invalid message", event.data);
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
      console.warn("Received invalid message", message);
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
    for (const client of this.#clients) {
      client.postMessage({ type: phase });
    }
  }

  get readinessPhase() {
    return this.#readinessPhase;
  }

  /** @param {TerminalFrame | { type: string } & import("type-fest").JsonObject} message */
  broadcast(message) {
    if (message.type === "stopping" || message.type === "error") {
      this.#terminalFrame = /** @type {TerminalFrame} */ (message);
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
}
