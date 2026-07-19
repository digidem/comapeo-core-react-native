/**
 * Minimal typed event emitter for the pure-JS discovery manager.
 *
 * Not expo's `EventEmitter` on purpose: that class is built around
 * native-module observation (`startObserving`/`stopObserving`) and
 * drags RN internals into Jest; `BleDiscovery` is plain JS state with
 * no native observation semantics of its own.
 */

type EventMap = Record<string, unknown[]>;

/** Internal erased-listener shape; per-event typing is enforced at the
 * public method signatures, so the casts below are sound. */
type AnyListener = (...args: never[]) => void;

export class TypedEmitter<Events extends EventMap> {
  #listeners = new Map<keyof Events, Set<AnyListener>>();

  addListener<EventName extends keyof Events>(
    eventName: EventName,
    listener: (...args: Events[EventName]) => void,
  ): void {
    let set = this.#listeners.get(eventName);
    if (!set) {
      set = new Set();
      this.#listeners.set(eventName, set);
    }
    set.add(listener as unknown as AnyListener);
  }

  removeListener<EventName extends keyof Events>(
    eventName: EventName,
    listener: (...args: Events[EventName]) => void,
  ): void {
    this.#listeners.get(eventName)?.delete(listener as unknown as AnyListener);
  }

  removeAllListeners(eventName?: keyof Events): void {
    if (eventName === undefined) {
      this.#listeners.clear();
    } else {
      this.#listeners.delete(eventName);
    }
  }

  protected emit<EventName extends keyof Events>(
    eventName: EventName,
    ...args: Events[EventName]
  ): void {
    const set = this.#listeners.get(eventName);
    if (!set) return;
    // Copy so a listener mutating subscriptions doesn't skip peers.
    for (const listener of [...set]) {
      (listener as unknown as (...a: Events[EventName]) => void)(...args);
    }
  }
}
