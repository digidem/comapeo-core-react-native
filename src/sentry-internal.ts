import type { SentryAdapter } from "./sentry";

/**
 * Probes for `@sentry/react-native` at module load. Indirected
 * through a synthetic `r` so Metro doesn't statically bundle the
 * optional peer dep — when the consumer hasn't installed it the
 * `require` throws, we catch, and the module stays inert. This
 * is the standard React Native pattern for optional peer deps.
 *
 * Tests can override the resolved adapter via
 * [setOverrideAdapter]; pass `null` to fall back to the
 * auto-detected one.
 */
let detected: SentryAdapter | null = null;
try {
  const r: NodeRequire = require;
  detected = r("@sentry/react-native") as SentryAdapter;
} catch {
  // Optional peer dep absent — module stays inert.
}

let override: SentryAdapter | null = null;

/** Returns the active adapter — override (test) or auto-detected. */
export function activeAdapter(): SentryAdapter | null {
  return override ?? detected;
}

/** Test-only: replace the adapter with a fake; pass null to reset. */
export function setOverrideAdapter(next: SentryAdapter | null): void {
  override = next;
}
