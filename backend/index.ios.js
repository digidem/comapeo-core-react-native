// iOS-only entry. Installs the polywasm WebAssembly polyfill, then the
// undici-backed `fetch`/`Response`/`Request` globals (absent on this
// jitless nodejs-mobile build), before running the shared `index.js`
// boot for side effects. ESM evaluates imports in source-order of the
// entry's import declarations, so `install-polywasm.js` runs first and
// gives undici a working `WebAssembly` global, then `install-fetch.js`
// loads undici and installs the globals the map server needs.

import "./lib/install-polywasm.js";
import "./lib/install-fetch.js";
import "./index.js";
