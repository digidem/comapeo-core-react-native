import { ServerHelper } from "./server-helper.js";
import { SocketMessagePort } from "./message-port.js";

/**
 * @typedef {{ type: "stopping" } | { type: "error", phase: string, message: string, stack?: string }} TerminalFrame
 */

/**
 * Control-socket server: routes inbound requests by message `type` and
 * broadcasts lifecycle transitions to all connected clients.
 *
 * The readiness state machine has three phases. They reflect the two-stage
 * boot the host now drives — control socket first, then `MapeoManager`
 * construction (which needs a rootKey from native), then the comapeo RPC
 * socket:
 *
 *   - `pre-listening` — control socket has not yet bound. Clients connecting
 *     in this window receive nothing; they'll get the broadcast as soon as
 *     the host calls `setReadinessPhase("started")`.
 *   - `started`       — control socket is accepting connections. The host
 *     is waiting for an `{type:"init", rootKey:"<base64>"}` frame so it can
 *     construct `MapeoManager`. Emitted as `{type:"started"}`. Native sends
 *     the init frame in response.
 *   - `ready`         — `MapeoManager` exists and the comapeo RPC socket is
 *     bound. Emitted as `{type:"ready"}`. RPC clients (the React Native
 *     module) can safely connect and call methods.
 *
 * Late-connecting clients receive replays in order: readiness frames
 * (`started` then `ready`) followed by the latest terminal frame
 * (`stopping` or `error`) if one has been emitted, so they converge on
 * the same state an early joiner would have seen.
 *
 * Methods registered on the constructor are invoked with the full inbound
 * message — handlers can read fields beyond `type` (e.g. `init.rootKey`).
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
  /**
   * Sentry frames (`sentry-event` and `sentry-envelope`) broadcast
   * before any client has connected. Drained to (and only to) the
   * first client on connect, so events captured during Node boot —
   * before the FGS / iOS module has had time to connect — aren't
   * lost. Bounded at 100; oldest is evicted on overflow.
   *
   * @type {import("type-fest").JsonObject[]}
   */
  #pendingSentryFrames = [];
  static #MAX_PENDING_SENTRY_FRAMES = 100;

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
    messagePort.on("message", (msg) => this.#handleMessage(msg));
    messagePort.on("messageerror", (error) => {
      console.error("Client sent invalid message", error);
    });
    messagePort.on("close", () => {
      this.#clients.delete(messagePort);
    });
    this.#clients.add(messagePort);
    messagePort.start();

    if (this.#readinessPhase === "started" || this.#readinessPhase === "ready") {
      messagePort.postMessage({ type: "started" });
    }
    if (this.#readinessPhase === "ready") {
      messagePort.postMessage({ type: "ready" });
    }
    if (this.#terminalFrame !== null) {
      messagePort.postMessage(this.#terminalFrame);
    }
    // Drain Sentry frames captured during boot. Only the first
    // client to connect receives them — subsequent clients are
    // assumed to be peers of the same backend (e.g. on Android the
    // FGS and main-app processes both connect; the FGS handles
    // events/envelopes, the main-app ignores them) and would
    // double-capture if we replayed. The fact that the FGS connects
    // before the main-app in practice is what makes this safe.
    if (this.#pendingSentryFrames.length > 0) {
      for (const frame of this.#pendingSentryFrames) {
        messagePort.postMessage(frame);
      }
      this.#pendingSentryFrames.length = 0;
    }
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
    this.#methods[message.type](message);
  }

  /**
   * Advance the readiness state machine and broadcast the matching message.
   * Idempotent — re-entering the same phase is a no-op (no second broadcast).
   *
   * @param {"started" | "ready"} phase
   */
  setReadinessPhase(phase) {
    if (this.#readinessPhase === phase) return;
    if (
      phase === "ready" &&
      this.#readinessPhase !== "started"
    ) {
      // Forbid `ready` before `started`. The host starts in `pre-listening`
      // and must transition through `started` first; skipping desyncs late
      // clients (who'd see `ready` without `started`).
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
    // Hold Sentry frames when nobody is listening yet. The forwarding
    // transport in `loader.mjs` calls broadcast as soon as `index.js`
    // registers it — which is right after the control socket binds
    // but before any client has had time to connect. The first
    // client to connect drains this buffer. See `#pendingSentryFrames`
    // for the bound + eviction policy.
    if (
      (message.type === "sentry-event" || message.type === "sentry-envelope") &&
      this.#clients.size === 0
    ) {
      if (
        this.#pendingSentryFrames.length >=
        SimpleRpcServer.#MAX_PENDING_SENTRY_FRAMES
      ) {
        this.#pendingSentryFrames.shift();
      }
      this.#pendingSentryFrames.push(
        /** @type {import("type-fest").JsonObject} */ (message),
      );
      return;
    }
    for (const client of this.#clients) {
      try {
        client.postMessage(message);
      } catch (e) {
        console.error("broadcast: client postMessage threw", e);
      }
    }
  }
}
