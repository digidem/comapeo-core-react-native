// @ts-check
import path from "node:path";
import { fileURLToPath } from "node:url";
import { includeIgnoreFile } from "@eslint/compat";
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import { createRequire } from "node:module";
import tseslint from "typescript-eslint";

const require = createRequire(import.meta.url);
const expo = require("expo-module-scripts/eslint.config.base");

const gitignorePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  ".gitignore",
);

const gitExcludePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  ".git",
  "info",
  "exclude",
);

export default defineConfig([
  includeIgnoreFile(gitignorePath),
  includeIgnoreFile(gitExcludePath),
  {
    name: "ignores",
    ignores: ["android/**/*", "example/**/*", "ios/**/*"],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    name: "node",
    files: ["backend/**/*", "scripts/**/*"],
    languageOptions: {
      globals: { ...globals.node, ...globals.nodeBuiltin },
    },
  },
  {
    name: "expo",
    extends: [expo],
    rules: {
      "import/order": "off",
      "prettier/prettier": "off",
    },
  },
]);
