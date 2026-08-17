import { flushCompileCache, getCompileCacheDir } from "node:module";

/**
 * Persist V8's code cache for everything compiled so far.
 *
 * The cache itself is enabled by native through `NODE_COMPILE_CACHE`
 * rather than `module.enableCompileCache()`, because the env var is read
 * when the Environment is created — early enough to cover `loader.mjs`
 * and the Sentry chunk, which are the two biggest compiles on the boot
 * path and both run before any JS of ours could call the runtime API.
 *
 * Node's own flush runs from an `exit` handler, which on mobile is the
 * one moment we can't count on: Android's low-memory killer takes the
 * `:ComapeoCore` process outright, and iOS usually kills the app while
 * suspended without ever reaching `applicationWillTerminate`. A cache
 * that only lands on a clean exit would rarely land at all, so flush at
 * `ready` instead — by then every module on the boot path, which is the
 * set worth caching, has been compiled.
 *
 * No-ops when the env var is unset.
 */
export function flushCompileCacheAfterBoot() {
  const dir = getCompileCacheDir();
  if (!dir) return;
  // After the `ready` frame is on the wire — the flush is synchronous.
  setImmediate(() => {
    flushCompileCache();
    console.log(`Compile cache flushed to ${dir}`);
  });
}
