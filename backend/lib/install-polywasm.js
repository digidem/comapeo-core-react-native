// Pure-JS WebAssembly polyfill, installed before anything that touches
// undici. nodejs-mobile on iOS runs V8 with `--jitless` and is built
// with `v8_enable_webassembly=false`, so `globalThis.WebAssembly` is
// absent (or a partial stub). undici's `lazyllhttp()` runs at
// module-init and would throw `WebAssembly is not defined` before the
// entry can boot.
//
// Imported only from `index-ios.js` — Android keeps native WebAssembly
// and pays no cost for polywasm.
//
// We swap polywasm in whenever the native `WebAssembly.compile` isn't
// callable: `typeof WebAssembly === "undefined"` is not enough, since a
// partial stub that defines the namespace but no methods would slip
// past and break undici lazily.

import { WebAssembly as PolyWebAssembly } from "polywasm";

const native = globalThis.WebAssembly;
const hasNativeCompile = native && typeof native.compile === "function";
if (!hasNativeCompile) {
  globalThis.WebAssembly = PolyWebAssembly;
  console.log(
    `[install-polywasm] installed polywasm (native.compile=${
      native ? typeof native.compile : "no global"
    })`,
  );
} else {
  console.log("[install-polywasm] native WebAssembly.compile present, skipping");
}
