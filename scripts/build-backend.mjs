#!/usr/bin/env node

import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { downloadPrebuilds } from "./download-prebuilds.mjs";

const require = createRequire(import.meta.url);

const nodejsAssetsDirectory = fileURLToPath(
  new URL("../android/src/main/assets/nodejs-project", import.meta.url)
);

const {
  values: { prod },
} = parseArgs({
  options: { prod: { type: "boolean" } },
});

console.log("Downloading native prebuilds...");

// TODO: Figure out how to know if module uses N-API at runtime
const NATIVE_MODULES = [
  { name: "better-sqlite3", usesNapi: false },
  { name: "crc-native", usesNapi: true },
  { name: "fs-native-extensions", usesNapi: true },
  { name: "quickbit-native", usesNapi: true },
  { name: "simdle-native", usesNapi: true },
  { name: "sodium-native", usesNapi: true },
];

await downloadPrebuilds(
  NATIVE_MODULES.map((m) => {
    const pkgJsonPath = require.resolve(`${m.name}/package.json`, {
      paths: [nodejsAssetsDirectory],
    });

    const { version } = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));

    return { ...m, version };
  })
);

// ------------------------------------------------

console.log("DONE!");
