import path from "node:path";
import { fileURLToPath } from "node:url";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import alias from "@rollup/plugin-alias";
import commonjs from "@rollup/plugin-commonjs";
import { default as esmShim } from "@rollup/plugin-esm-shim";
import json from "@rollup/plugin-json";

import nativePaths from "./rollup-plugins/rollup-plugin-native-paths.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MAPS_STUB_PATH = path.join(__dirname, "lib", "maps-stub.js");

/**
 * Resolves `@comapeo/core`'s `./fastify-plugins/maps.js` import to the
 * iOS-only no-op stub. Scoped tightly to the `@comapeo/core/src/` importer
 * so unrelated packages with a similarly-named file aren't caught.
 *
 * @returns {import('rollup').Plugin}
 */
function stubComapeoMapsPlugin() {
  return {
    name: "stub-comapeo-maps-plugin",
    resolveId(source, importer) {
      if (
        source === "./fastify-plugins/maps.js" &&
        importer &&
        importer.includes("@comapeo/core/src/")
      ) {
        return MAPS_STUB_PATH;
      }
      return null;
    },
  };
}

/**
 * @param {{ stubMaps: boolean }} options
 * @returns {import('rollup').RollupOptions['plugins']}
 */
function buildPlugins({ stubMaps }) {
  return [
    alias({
      entries: [
        // @comapeo/core (indirectly) depends on @node-rs/crc32, which can't be rolled up.
        // Replace it with a pure JavaScript implementation.
        {
          find: "@node-rs/crc32",
          replacement: path.join(__dirname, "lib", "node-rs-crc32-shim.js"),
        },
      ],
    }),
    // iOS-only: stub the maps fastify plugin so undici stays out of the
    // bundle. See lib/maps-stub.js.
    ...(stubMaps ? [stubComapeoMapsPlugin()] : []),
    nativePaths(),
    // @ts-expect-error Types for these rollup plugins are misconfigured: https://github.com/rollup/plugins/issues/1860
    commonjs({ ignoreDynamicRequires: true }),
    // @ts-expect-error Types for these rollup plugins are misconfigured: https://github.com/rollup/plugins/issues/1860
    esmShim(),
    nodeResolve({ preferBuiltins: true }),
    // @ts-expect-error Types for these rollup plugins are misconfigured: https://github.com/rollup/plugins/issues/1860
    json(),
  ];
}

const sharedInput = {
  index: path.join(__dirname, "index.js"),
};

const sharedOutput = {
  format: /** @type {const} */ ("esm"),
  sourcemap: true,
  entryFileNames: "[name].mjs",
};

/**
 * Two outputs from the same source tree. Android gets the full bundle —
 * its nodejs-mobile build permits JIT, so undici (and therefore the maps
 * fastify plugin) loads cleanly. iOS gets the same bundle but with
 * `@comapeo/core`'s maps plugin swapped for a no-op (see lib/maps-stub.js)
 * because nodejs-mobile iOS runs V8 with `--jitless` and undici's
 * WebAssembly init would crash module load. The platform-specific dist
 * directories are consumed by `scripts/build-backend.ts`.
 *
 * @type {import('rollup').RollupOptions[]}
 */
const config = [
  {
    input: sharedInput,
    output: { ...sharedOutput, dir: path.join(__dirname, "dist/android") },
    plugins: buildPlugins({ stubMaps: false }),
  },
  {
    input: sharedInput,
    output: { ...sharedOutput, dir: path.join(__dirname, "dist/ios") },
    plugins: buildPlugins({ stubMaps: true }),
  },
];

export default config;
