import type { SentryAdapter } from "./sentry";

/**
 * Adapter holder populated by the `/sentry` sub-export at module load.
 *
 * This file deliberately does NOT import `@sentry/react-native` —
 * `ComapeoCoreModule.ts` reaches it via the main barrel, and a static
 * import would force every consumer to install the optional peer dep.
 */
let registered: SentryAdapter | null = null;
let override: SentryAdapter | null = null;

/** Called by the `/sentry` sub-export with its imported SDK namespace. */
export function registerAdapter(adapter: SentryAdapter | null): void {
  registered = adapter;
}

export function activeAdapter(): SentryAdapter | null {
  return override ?? registered;
}

/** Test-only: replace the adapter with a fake; pass null to reset. */
export function setOverrideAdapter(next: SentryAdapter | null): void {
  override = next;
}
