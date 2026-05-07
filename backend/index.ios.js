// iOS-only entry. Installs the polywasm WebAssembly polyfill before any
// other module is evaluated, then runs the shared `index.js` boot for
// side effects. ESM evaluates imports in source-order of the entry's
// import declarations, so `install-polywasm.js` runs first and gives
// undici a working `WebAssembly` global by the time it loads.

import "./lib/install-polywasm.js";
import "./index.js";
