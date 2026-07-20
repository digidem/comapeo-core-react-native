import type { JsonValue } from "type-fest";

/**
 * Tracks the live rpc-reflector subscription frames flowing out through
 * the shared message port, so they can be replayed after the embedded
 * backend restarts.
 *
 * The backend builds a fresh per-connection rpc-reflector server that
 * remembers no prior subscriptions, but the rpc-reflector *client*
 * sends its `ON` frame only at `.on()` time and never resubscribes — so
 * after a backend respawn (Android FGS restart, iOS relaunch) the new
 * server forwards no more events and streams like `discovery-state` /
 * `local-peers` silently go dark. Recording `ON`/`OFF` here and
 * replaying the live set on reconnect closes that gap for every
 * subscription on the port at once.
 *
 * Frame shape (rpc-reflector/lib/constants.js): subscriptions are
 * `ON` = `[2, eventName, propArray]`, unsubscriptions `OFF` =
 * `[3, eventName, propArray]`; both are bare arrays. REQUESTs — the
 * only other outbound frame — are always `{ value, metadata }` objects,
 * so `Array.isArray` distinguishes them. Kept as a standalone,
 * dependency-free unit so the record/OFF/replay logic is testable
 * without standing up the native module.
 */
const RPC_MSGTYPE_ON = 2;
const RPC_MSGTYPE_OFF = 3;

export class SubscriptionLog {
  /** key `JSON.stringify([eventName, propArray])` → the ON frame. */
  #subscriptions = new Map<string, JsonValue>();

  /** Observe an outbound frame; records `ON`, forgets on `OFF`, ignores
   * everything else. Safe to call on every `postMessage`. */
  record(value: JsonValue): void {
    if (!Array.isArray(value) || value.length < 3) return;
    const [tag, eventName, propArray] = value;
    if (tag !== RPC_MSGTYPE_ON && tag !== RPC_MSGTYPE_OFF) return;
    const key = JSON.stringify([eventName, propArray]);
    if (tag === RPC_MSGTYPE_ON) {
      this.#subscriptions.set(key, value);
    } else {
      this.#subscriptions.delete(key);
    }
  }

  /** The live subscription frames, for replay after a reconnect. */
  activeFrames(): JsonValue[] {
    return [...this.#subscriptions.values()];
  }
}
