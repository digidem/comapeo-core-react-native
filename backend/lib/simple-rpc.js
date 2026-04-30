import { ServerHelper } from "./server-helper.js";
import { SocketMessagePort } from "./message-port.js";

/**
 * Control-socket server: routes inbound requests by message `type` and
 * broadcasts readiness transitions to all connected clients.
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
 * Late-connecting clients receive both replayed messages in order, so a
 * native control-IPC client that finishes `waitForFile()` + retry-connect
 * after the one-shot broadcast still sees the transitions.
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

    // Replay readiness for late-connecting clients. Order matters:
    // `started` always before `ready`, so a client that watches for
    // `started` separately sees it before the `ready` follow-up.
    if (this.#readinessPhase === "started" || this.#readinessPhase === "ready") {
      messagePort.postMessage({ type: "started" });
    }
    if (this.#readinessPhase === "ready") {
      messagePort.postMessage({ type: "ready" });
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

  /**
   * Broadcast `{type:"error", phase, message, stack?}` to every connected
   * client. Used by the host's uncaughtException handler and by explicit
   * boot-failure paths so native can transition to its `error` state.
   *
   * Non-replayed: a client connecting after this fires gets nothing,
   * because the process is about to exit and the socket will close
   * shortly anyway. Native's existing connection-close handling covers
   * that case.
   *
   * @param {{ phase: string, message: string, stack?: string }} payload
   */
  broadcastError(payload) {
    const frame = { type: "error", ...payload };
    for (const client of this.#clients) {
      try {
        client.postMessage(frame);
      } catch (e) {
        // Best-effort: a single client whose socket already errored
        // shouldn't block the rest from seeing the error frame.
        console.error("broadcastError: client postMessage threw", e);
      }
    }
  }
}
