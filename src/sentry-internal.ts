import * as Sentry from "@sentry/react-native";

import type { SentryAdapter } from "./sentry";

/**
 * Static import of `@sentry/react-native`. Originally this was a
 * `try { require(...) }` so the package could no-op when the
 * peer dep wasn't installed, but Metro's static bundler doesn't
 * reliably bind aliased dynamic requires — the resolved module
 * came back as `undefined` at runtime, leaving `detected = null`
 * and silently disabling every scope-level write the comapeo
 * sub-export tries to do (tags, event processors).
 *
 * Importing this sub-export now requires the consumer to have
 * `@sentry/react-native` installed. Since the sub-export
 * (`@comapeo/core-react-native/sentry`) is opt-in by its own
 * import path, that's the correct contract — anyone importing
 * the Sentry adapter is by definition using Sentry.
 *
 * Tests can override the resolved adapter via
 * [setOverrideAdapter]; pass `null` to fall back to the imported
 * one.
 */
const detected: SentryAdapter = Sentry as unknown as SentryAdapter;

let override: SentryAdapter | null = null;

/** Returns the active adapter — override (test) or imported. */
export function activeAdapter(): SentryAdapter | null {
  return override ?? detected;
}

/** Test-only: replace the adapter with a fake; pass null to reset. */
export function setOverrideAdapter(next: SentryAdapter | null): void {
  override = next;
}
