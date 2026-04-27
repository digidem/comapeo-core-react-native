import { ServerHelper } from "./server-helper.js";
import { SocketMessagePort } from "./message-port.js";

/**
 * Control-socket server: routes inbound requests by message `type` and
 * broadcasts readiness transitions to all connected clients.
 *
 * The readiness state machine has three phases. They mirror what the embedded
 * Node process can guarantee about its own startup:
 *
 *   - `pre-listening` — both UDS servers (control + comapeo RPC) have not yet
 *     resolved their `listen()` promises. Clients connecting in this window
 *     receive nothing; they'll get the broadcast as soon as the host calls
 *     `setReadinessPhase("started")`.
 *   - `started`       — both servers are accepting connections. Emitted as
 *     `{type: "started"}`. Held for a 1 s settle window before transitioning.
 *   - `ready`         — past the settle window. Emitted as `{type: "ready"}`.
 *     A late-connecting client (one whose accept() lands after the broadcast)
 *     receives both replayed messages on connect, in order.
 *
 * The settle window is what makes the iOS Swift state-IPC client reliable:
 * `NodeJSIPC.connect()` polls for the socket file with `waitForFile()` and
 * then runs `connectWithRetry()`, which on simulator runs can take ~50 ms
 * after the file appears. Without the replay, any IPC client that finishes
 * its retry handshake after the one-shot broadcast lost the message.
 *
 * @template {Record<string, (...args: any[]) => any>} TMethods
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
    // `started` always before `ready` — Swift tests assert on contains() so
    // both can ride along on the same accept, but a client that intends to
    // act on `started` separately needs to see it first.
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
    this.#methods[message.type]();
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
}
