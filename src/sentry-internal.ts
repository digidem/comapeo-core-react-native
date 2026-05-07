import type { SentryAdapter } from "./sentry";

/**
 * Module-private adapter holder. The sub-export
 * (`@comapeo/core-react-native/sentry`) populates this when its
 * top-level side effect runs (which is also what does the static
 * `import * as Sentry from "@sentry/react-native"`).
 *
 * This file deliberately does NOT import `@sentry/react-native`
 * itself: it sits in the import graph reachable from the main
 * barrel via `ComapeoCoreModule.ts` (RPC client tracing hook), and
 * pulling the SDK in here would force every consumer to install
 * the optional peer dep even if they never opt in to Sentry.
 *
 * Tests can override the adapter via [setOverrideAdapter]; pass
 * `null` to fall back to whatever the sub-export registered.
 */
let registered: SentryAdapter | null = null;
let override: SentryAdapter | null = null;

/**
 * Internal — the `/sentry` sub-export calls this with the imported
 * `@sentry/react-native` namespace. Idempotent; the second call
 * wins (consumers don't re-register, but defensive against ever
 * shipping multiple call sites).
 */
export function registerAdapter(adapter: SentryAdapter | null): void {
  registered = adapter;
}

/** Returns the active adapter — override (test) or registered. */
export function activeAdapter(): SentryAdapter | null {
  return override ?? registered;
}

/** Test-only: replace the adapter with a fake; pass null to reset. */
export function setOverrideAdapter(next: SentryAdapter | null): void {
  override = next;
}
