/**
 * Runtime `@sentry/*` packages locked at more than one version. Sentry keeps
 * its global state per SDK version, so two copies of e.g. `@sentry/core` in
 * the backend bundle silently split spans from the client that sends them.
 * Dev-only entries are ignored: they never reach the bundle.
 *
 * @param {{ packages?: Record<string, { name?: string, version?: string, dev?: boolean }> }} lock
 *   a parsed npm v2/v3 `package-lock.json`
 * @returns {Map<string, string[]>} package name → sorted distinct versions
 */
export function findDuplicateSentryPackages(lock) {
  /** @type {Map<string, Set<string>>} */
  const versions = new Map();
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    const name = path.match(/(?:^|\/)node_modules\/(@sentry\/[^/]+)$/)?.[1];
    if (!name || entry.dev || !entry.version) continue;
    if (!versions.has(name)) versions.set(name, new Set());
    versions.get(name)?.add(entry.version);
  }
  /** @type {Map<string, string[]>} */
  const duplicates = new Map();
  for (const [name, set] of versions) {
    if (set.size > 1) duplicates.set(name, [...set].sort());
  }
  return duplicates;
}
