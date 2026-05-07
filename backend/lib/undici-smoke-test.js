// TEMPORARY smoke test: verifies that `undici.fetch()` actually works
// inside the bundled backend. On iOS this exercises the polywasm path
// (V8 is jitless, no native `WebAssembly`); on Android it exercises the
// native path. Removable once the maps plugin's first real tile fetch
// has proved the path on a device.
//
// Self-contained — spins up a one-shot 127.0.0.1 HTTP server, fetches
// it, validates the response. No network required, so a misconfigured
// device or simulator won't produce a false negative.

import { createServer } from "node:http";
import { fetch } from "undici";

export async function runUndiciSmokeTest() {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(undefined));
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("smoke server: unexpected address");
  }
  try {
    const res = await fetch(`http://127.0.0.1:${address.port}/`);
    if (res.status !== 200) {
      throw new Error(`smoke fetch: status ${res.status}`);
    }
    const body = await res.text();
    if (body !== "ok") {
      throw new Error(`smoke fetch: body ${JSON.stringify(body)}`);
    }
    console.log("[undici-smoke-test] PASSED");
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
}
