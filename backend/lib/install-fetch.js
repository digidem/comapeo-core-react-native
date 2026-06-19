// nodejs-mobile on iOS ships Node 18 without the undici-backed global
// `fetch`/`Response`/`Request`/`Headers` (the jitless `v8_enable_webassembly=false`
// build skips the bootstrap that installs them; `ReadableStream` is still
// present). `@comapeo/map-server` serves over `@whatwg-node` + `itty-router`,
// both of which construct `new Response(...)`/`new Request(...)` against the
// globals — so without these the HTTP handler throws "Response is not defined"
// and never replies, and a fetch to the map server hangs.
//
// Pull the implementations from undici (which loads because
// `install-polywasm.js` ran first) onto `globalThis`. Imported only from
// `index.ios.js`; Android keeps its native globals and pays no cost.

import { fetch, Headers, Request, Response, FormData, File } from "undici";

const impls = { fetch, Headers, Request, Response, FormData, File };
const g = /** @type {Record<string, unknown>} */ (
  /** @type {unknown} */ (globalThis)
);
const installed = [];
for (const [name, value] of Object.entries(impls)) {
  if (typeof g[name] === "undefined") {
    g[name] = value;
    installed.push(name);
  }
}
console.log(
  `[install-fetch] installed ${installed.length ? installed.join(",") : "nothing (globals present)"}`,
);
