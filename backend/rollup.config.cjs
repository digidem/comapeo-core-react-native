const process = require("node:process");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const alias = require("@rollup/plugin-alias").default;
const commonjs = require("@rollup/plugin-commonjs").default;
const json = require("@rollup/plugin-json").default;
const { nodeResolve } = require("@rollup/plugin-node-resolve");
const esmShim = require("@rollup/plugin-esm-shim").default;
const replace = require("@rollup/plugin-replace").default;

const env = process.env.BUILD_ENV || "development";

/** @type {import('rollup').RollupOptions['plugins']} */
const plugins = [
  replace({
    values: {
      __filename: (id) => {
        console.log(id);
        return "__filename";
      },
    },
  }),
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
  commonjs({
    ignoreDynamicRequires: true,
  }),
  esmShim(),
  nodeResolve({ preferBuiltins: true }),
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

module.exports = config;
