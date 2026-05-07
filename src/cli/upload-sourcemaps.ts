#!/usr/bin/env node
// Uploads the Node-backend bundle's sourcemaps to the consumer's Sentry
// project. Run from the consumer's CI step (after `eas build` or as part
// of the release pipeline). Re-uploading is idempotent — Sentry de-dupes
// by debug ID.
//
// Three targets ship with the package:
//
//   android-debug → android/src/debug/assets/nodejs-project/index.mjs
//                   android/src/debug/nodejs-sourcemaps/index.mjs.map
//   android-main  → android/src/main/assets/nodejs-project/index.mjs
//                   android/src/main/nodejs-sourcemaps/index.mjs.map
//   ios           → ios/nodejs-project/index.mjs
//                   ios/nodejs-sourcemaps/index.mjs.map
//
// Each (bundle, map) pair is keyed by a deterministic debug ID embedded
// at build time (`stringToUUID(chunk.code)`); see
// `backend/rollup.config.ts` and `relocateSourcemapsPlugin`. sentry-cli
// 2.x+ does debug-ID-based upload by default — symbolication keys off
// the embedded ID, so the consumer's app `release` does not have to
// match.
//
// Auth token is read from `SENTRY_AUTH_TOKEN`. Org and project come from
// `--org`/`--project` (or `SENTRY_ORG`/`SENTRY_PROJECT`).
//
// `@sentry/cli` is resolved via the consumer's transitive
// `@sentry/react-native` install. Consumers without `@sentry/react-native`
// must add `@sentry/cli` to their devDeps.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

interface Target {
  name: string;
  bundleDir: string;
  sourcemapDir: string;
}

// `build/cli/upload-sourcemaps.js` → up three to package root.
const PKG_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const TARGETS: Record<string, Target> = {
  "android-debug": {
    name: "android-debug",
    bundleDir: join(PKG_ROOT, "android/src/debug/assets/nodejs-project"),
    sourcemapDir: join(PKG_ROOT, "android/src/debug/nodejs-sourcemaps"),
  },
  "android-main": {
    name: "android-main",
    bundleDir: join(PKG_ROOT, "android/src/main/assets/nodejs-project"),
    sourcemapDir: join(PKG_ROOT, "android/src/main/nodejs-sourcemaps"),
  },
  ios: {
    name: "ios",
    bundleDir: join(PKG_ROOT, "ios/nodejs-project"),
    sourcemapDir: join(PKG_ROOT, "ios/nodejs-sourcemaps"),
  },
};

const DEFAULT_TARGETS = "android-debug,android-main,ios";

const USAGE = `\
Usage: comapeo-rn-upload-sourcemaps [options]

Uploads sourcemaps for the @comapeo/core-react-native backend bundle to
Sentry, using debug-ID-based symbolication.

Options:
  --org <slug>         Sentry org slug (or SENTRY_ORG env var).
  --project <slug>     Sentry project slug (or SENTRY_PROJECT env var).
  --url <url>          Sentry instance URL (default sentry.io; or SENTRY_URL).
  --targets <list>     Comma-separated subset of: android-debug, android-main,
                       ios. Default: all three.
  -h, --help           Show this help.

Required env:
  SENTRY_AUTH_TOKEN    Auth token with project:write scope.

The CLI shells out to @sentry/cli, which it locates via the consumer's
@sentry/react-native install. Consumers without @sentry/react-native must
add @sentry/cli themselves.
`;

function fail(msg: string): never {
  process.stderr.write(`comapeo-rn-upload-sourcemaps: ${msg}\n`);
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    org: { type: "string" },
    project: { type: "string" },
    url: { type: "string" },
    targets: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: false,
});

if (values.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const org = values.org ?? process.env.SENTRY_ORG;
const project = values.project ?? process.env.SENTRY_PROJECT;
const url = values.url ?? process.env.SENTRY_URL;

if (!org) fail("missing --org (or SENTRY_ORG env var)");
if (!project) fail("missing --project (or SENTRY_PROJECT env var)");
if (!process.env.SENTRY_AUTH_TOKEN) fail("missing SENTRY_AUTH_TOKEN env var");

const selectedNames = (values.targets ?? DEFAULT_TARGETS)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const unknown = selectedNames.filter((n) => !TARGETS[n]);
if (unknown.length > 0) {
  fail(
    `unknown --targets entries: ${unknown.join(", ")}. ` +
      `Valid: ${Object.keys(TARGETS).join(", ")}`,
  );
}

// `@sentry/cli/bin/sentry-cli` is a Node wrapper that resolves and execs
// the platform-specific binary. Resolving from this file's URL walks the
// consumer's `node_modules` upward, finding it via the
// `@sentry/react-native` → `@sentry/cli` transitive chain.
const require_ = createRequire(import.meta.url);
let sentryCliBin: string;
try {
  sentryCliBin = require_.resolve("@sentry/cli/bin/sentry-cli");
} catch {
  fail(
    "could not resolve @sentry/cli. Install @sentry/react-native " +
      "(which depends on it) or add @sentry/cli to your devDeps.",
  );
}

for (const name of selectedNames) {
  const t = TARGETS[name]!;
  if (!existsSync(t.bundleDir)) {
    fail(`${name}: bundle dir missing (${t.bundleDir})`);
  }
  if (!existsSync(t.sourcemapDir)) {
    fail(`${name}: sourcemap dir missing (${t.sourcemapDir})`);
  }

  process.stdout.write(`[${name}] uploading sourcemaps to ${org}/${project}\n`);
  // Modern sentry-cli (2.x+) does debug-ID-based upload by default —
  // it scans <PATHS> for `_sentryDebugIdIdentifier` / trailing
  // `//# debugId=` in JS files and `debug_id` in maps, then groups them
  // into artifact bundles keyed by debug ID. No `--debug-ids` flag.
  //
  // `--no-rewrite` skips sentry-cli's `discover_sourcemaps_location`
  // step, which would otherwise follow the bundle's
  // `//# sourceMappingURL=index.mjs.map` and look for an adjacent map
  // — but our maps live in a sibling `nodejs-sourcemaps/` dir, so the
  // walk warns and no-ops. The IDs are already embedded in both files
  // (see `relocateSourcemapsPlugin`), which is exactly the case
  // `--no-rewrite` is documented for.
  const result = spawnSync(
    process.execPath,
    [
      sentryCliBin,
      "sourcemaps",
      "upload",
      "--no-rewrite",
      "--org",
      org,
      "--project",
      project,
      ...(url ? ["--url", url] : []),
      t.bundleDir,
      t.sourcemapDir,
    ],
    { stdio: "inherit" },
  );

  if (result.status !== 0) {
    fail(`[${name}] sentry-cli exited with status ${result.status ?? "null"}`);
  }
}
