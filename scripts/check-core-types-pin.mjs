#!/usr/bin/env node
// Invariant check: the `@comapeo/core` version in the root package.json
// must be an exact pin that matches the version the backend bundle embeds
// (`backend/package.json`). The root dependency is types-only — nothing on
// the React Native side imports core at runtime — but it is what the
// published `build/index.d.ts` resolves against (via `@comapeo/ipc`'s
// `import type { MapeoManager } from '@comapeo/core'`), so a mismatch means
// consumers typecheck against a different core API than the one actually
// running inside the embedded Node.js process.
//
// To bump core: update the version in BOTH `package.json` (dependencies)
// and `backend/package.json` (dependencies), run `npm install` and
// `npm run backend:install`, then re-run the type-surface tests
// (`npm run test:types`) to review any API-shape fallout.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** @param {string} pkgPath */
function readCoreDep(pkgPath) {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  return pkg.dependencies?.["@comapeo/core"] ?? null;
}

const rootPin = readCoreDep(join(root, "package.json"));
const backendPin = readCoreDep(join(root, "backend", "package.json"));

/** @type {string[]} */
const problems = [];

if (!rootPin) {
  problems.push(
    "package.json is missing `@comapeo/core` in dependencies. It must be " +
      "declared (types-only) so the published type declarations resolve in " +
      "consumer installs.",
  );
} else if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(rootPin)) {
  problems.push(
    `package.json pins @comapeo/core as "${rootPin}" — it must be an exact ` +
      "version (no ^ or ~), because the types must match the exact core " +
      "version embedded in the backend bundle.",
  );
}

if (!backendPin) {
  problems.push("backend/package.json is missing `@comapeo/core` in dependencies.");
}

if (rootPin && backendPin && rootPin !== backendPin) {
  problems.push(
    `@comapeo/core version mismatch: package.json has "${rootPin}" but ` +
      `backend/package.json has "${backendPin}". The root (types) pin must ` +
      "exactly match the version bundled into the backend — bump both together.",
  );
}

if (problems.length > 0) {
  console.error("check-core-types-pin failed:\n");
  for (const problem of problems) console.error(`  • ${problem}\n`);
  process.exit(1);
}

console.log(`check-core-types-pin: @comapeo/core pinned at ${rootPin} (root ⟷ backend in sync)`);
