// undici's `client-h1.js` calls `WebAssembly.compile` at module-init, so the
// `WebAssembly` global (installed by `install-polywasm.js`) must already exist
// when `install-fetch.js` imports undici. Imported between the two in
// `index.ios.js` to turn a wrong import order into a loud, clear failure
// instead of an opaque undici init error later.
if (typeof globalThis.WebAssembly === "undefined") {
  throw new Error(
    "WebAssembly global missing; install-polywasm.js must run before install-fetch.js",
  );
}
