import { rmSync } from "node:fs";
import { cp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import { default as esmShim } from "@rollup/plugin-esm-shim";
import json from "@rollup/plugin-json";
import { minify } from "rollup-plugin-esbuild";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Bench bundle output. The bench app's `with-comapeo-bench` config
 * plugin reads from this path during `expo prebuild` and copies the
 * tree into the consumer app's native asset/resource trees so
 * nodejs-mobile can find `<bundle>/index.mjs` at runtime.
 */
const OUT_DIR = path.join(__dirname, "dist");

/**
 * The bench backend imports framing helpers (server-helper.js,
 * simple-rpc.js, message-port.js) from the production backend's
 * `backend/lib/` via path-relative imports — keeps the wire framing
 * bit-identical to production, which is the whole point of the
 * benchmark. Rollup's `nodeResolve` walks the path-imported tree and
 * brings the helpers into the bundle directly; their dependencies
 * (`framed-stream`, `tiny-typed-emitter`, `ensure-error`) are listed
 * in this package's package.json and resolved out of
 * `apps/benchmark/backend/node_modules/`.
 *
 * Unlike the production rollup config there is no per-platform split:
 * the bench code never imports `@comapeo/core` (so no iOS maps-plugin
 * stub is needed) and never loads native addons (so no
 * platform-specific `__loadAddon` banner is needed). One ESM bundle
 * works on Android and iOS alike.
 */
function copyPackageJsonPlugin() {
  return {
    name: "copy-package-json",
    async writeBundle() {
      // Node's module resolver reads the unpacked tree's package.json
      // to set `"type": "module"` so `index.mjs` evaluates as ESM.
      await cp(
        path.join(__dirname, "package.json"),
        path.join(OUT_DIR, "package.json"),
      );
    },
  };
}

function cleanOutputDirPlugin() {
  return {
    name: "clean-output-dir",
    buildStart() {
      rmSync(OUT_DIR, { force: true, recursive: true });
    },
  };
}

export default {
  input: { index: path.join(__dirname, "index.js") },
  output: {
    dir: OUT_DIR,
    format: "esm",
    sourcemap: true,
    entryFileNames: "[name].mjs",
  },
  plugins: [
    cleanOutputDirPlugin(),
    commonjs({ ignoreDynamicRequires: true }),
    esmShim(),
    nodeResolve({ preferBuiltins: true }),
    json(),
    minify(),
    copyPackageJsonPlugin(),
  ],
};
