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

/** @type {import('rollup').RollupOptions['plugins']} */
const plugins = [
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
  nativePaths(),
  // @ts-expect-error Types for these rollup plugins are misconfigured: https://github.com/rollup/plugins/issues/1860
  commonjs({ ignoreDynamicRequires: true }),
  // @ts-expect-error Types for these rollup plugins are misconfigured: https://github.com/rollup/plugins/issues/1860
  esmShim(),
  nodeResolve({ preferBuiltins: true }),
  // @ts-expect-error Types for these rollup plugins are misconfigured: https://github.com/rollup/plugins/issues/1860
  json(),
];

/**
 * @type {import('rollup').RollupOptions}
 */
const config = {
  input: {
    index: path.join(__dirname, "index.js"),
  },
  output: {
    dir: path.join(__dirname, "dist"),
    format: "esm",
    sourcemap: true,
    entryFileNames: "[name].mjs",
  },
  plugins,
};

export default config;
