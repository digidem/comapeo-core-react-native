#!/usr/bin/env node
// Package-hygiene check for the published type surface (issue #99; see also
// #88 for the fuller tarball-contents job): runs `publint` (exports/types
// field consistency) and `@arethetypeswrong/cli` (resolution of the packed
// entrypoints under every module-resolution mode) against a packed tarball.
//
// The real tarball can't be used directly: it embeds the NodeMobile
// xcframework, whose deep paths produce tar headers that publint's and
// attw's JS untar implementations choke on — and packing it would run
// `prepack` (the full backend build) anyway. Instead we stage a minimal
// copy containing exactly what module/type resolution sees — package.json
// (scripts stripped), build/, src/, and the plugin entry — and pack that.
// Native artifacts are irrelevant to these tools; asserting their presence
// in the real tarball is #88's job.

import { execa } from "execa";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

if (!existsSync(join(root, "build", "index.d.ts"))) {
  console.error(
    "check-package-types: build/index.d.ts not found — run `npm run build` first.",
  );
  process.exit(1);
}

const stageDir = mkdtempSync(join(tmpdir(), "comapeo-pack-"));
let failed = false;

try {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  // No lifecycle scripts in the staged copy (prepack would rebuild the
  // backend), and only the resolution-relevant files.
  delete pkg.scripts;
  pkg.files = ["build/", "src/", "app.plugin.js", "expo-module.config.json"];
  writeFileSync(join(stageDir, "package.json"), JSON.stringify(pkg, null, 2));
  for (const entry of ["build", "src", "app.plugin.js", "expo-module.config.json"]) {
    cpSync(join(root, entry), join(stageDir, entry), { recursive: true });
  }

  const { stdout } = await execa(
    "npm",
    ["pack", "--json", "--pack-destination", stageDir],
    { cwd: stageDir },
  );
  // npm <= 11 emits a one-element array; npm >= 12 keys results by package
  // name. Normalize to the single result either way.
  const parsed = JSON.parse(stdout);
  const [{ filename }] = Array.isArray(parsed) ? parsed : Object.values(parsed);
  const tarball = join(stageDir, filename);

  // attw is scoped to what this package actually supports: the typed API
  // entrypoints (app.plugin and package.json are untyped build-time
  // plumbing), ESM-only (no CJS consumers — Metro and modern Node both use
  // the import condition), and `internal-resolution-error` ignored because
  // expo-module-scripts emits extensionless relative imports, which the
  // node16 resolver rejects but the bundler resolution (what React
  // Native/Metro consumers use) accepts — `tsc` already validates internal
  // resolution in-repo.
  for (const [name, args] of [
    ["publint", ["publint", tarball]],
    [
      "attw",
      [
        "attw",
        tarball,
        "--profile",
        "esm-only",
        "--entrypoints",
        ".",
        "sentry",
        "--ignore-rules",
        "internal-resolution-error",
      ],
    ],
  ]) {
    console.log(`\n── ${name} ──`);
    const result = await execa(args[0], args.slice(1), {
      cwd: root,
      preferLocal: true,
      localDir: root,
      reject: false,
      stdio: "inherit",
    });
    if (result.exitCode !== 0) failed = true;
  }
} finally {
  rmSync(stageDir, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
