// No-op stand-in for `@comapeo/core/src/fastify-plugins/maps.js`, swapped
// in by `rollup.config.js` for the iOS bundle only.
//
// The real plugin imports `undici`, whose `lazyllhttp()` calls
// `WebAssembly.compile` at module-init. nodejs-mobile iOS runs V8 with
// `--jitless` (Apple's no-JIT policy applies to App Store builds and is
// mirrored on the simulator), so the `WebAssembly` global is absent and
// undici crashes the process before the entry runs. Android is unaffected
// (JIT is permitted) and gets the real plugin via the Android-specific
// rollup output.
//
// Tile fetching is deferred to a later phase; once a non-WASM HTTP client
// is wired in for iOS, this file goes away.

export const CUSTOM_MAP_PREFIX = "custom";
export const FALLBACK_MAP_PREFIX = "fallback";

/** @type {import('fastify').FastifyPluginAsync<any>} */
export async function plugin() {}
