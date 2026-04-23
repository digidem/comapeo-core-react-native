import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { defineConfig } from "eslint/config";
import { createRequire } from "node:module";
import globals from "globals";

const require = createRequire(import.meta.url);
const expo = require("expo-module-scripts/eslint.config.base");

export default defineConfig([
  {
    name: "ignores",
    ignores: ["android", "build", "ios"],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    name: "backend",
    files: ["backend/**/*"],
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
