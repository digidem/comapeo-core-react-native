import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import { default as esmShim } from "@rollup/plugin-esm-shim";
import json from "@rollup/plugin-json";
import { minify } from "rollup-plugin-esbuild";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// No `package.json` emitted — the production bundle's package.json
// (with `"type":"module"`) sits beside us in `nodejs-project/`.
const OUT_DIR = path.join(__dirname, "dist");

// One ESM bundle for both platforms: the bench code never imports
// `@comapeo/core` (no iOS maps-plugin stub needed) and never loads
// native addons (no per-platform `__loadAddon` banner needed).
function cleanOutputDirPlugin() {
  return {
    name: "clean-output-dir",
    buildStart() {
      rmSync(OUT_DIR, { force: true, recursive: true });
    },
  };
}

export default {
  // Named-input form → emitted chunk is `index.bench.mjs`, can coexist
  // with the production `index.mjs` in the same `nodejs-project/`.
  input: { "index.bench": path.join(__dirname, "index.js") },
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
  ],
};
