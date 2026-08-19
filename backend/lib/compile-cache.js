import { flushCompileCache, getCompileCacheDir } from "node:module";

/**
 * Persist V8's code cache for everything compiled so far. No-op unless native
 * set `NODE_COMPILE_CACHE`.
 *
 * Flushed here rather than left to node's `exit` handler: the low-memory killer
 * and iOS's suspended-app kill both skip that hook, so the cache would rarely
 * be written at all. By `ready` the whole boot path — the set worth caching —
 * has compiled.
 */
export function flushCompileCacheAfterBoot() {
  const dir = getCompileCacheDir();
  if (!dir) return;
  // The flush is synchronous; let the `ready` frame reach the wire first.
  setImmediate(() => {
    flushCompileCache();
    console.log(`Compile cache flushed to ${dir}`);
  });
}
