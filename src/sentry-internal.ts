import type { SentryAdapter } from "./sentry";

let adapter: SentryAdapter | null = null;

export function setActiveAdapter(next: SentryAdapter | null): void {
  adapter = next;
}

export function activeAdapter(): SentryAdapter | null {
  return adapter;
}
