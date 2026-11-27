#!/usr/bin/env node
// Repo-local guard (npm skips `prepare` for registry installs): fails when the
// sentry-cocoa that the dev `@sentry/react-native` ships is older than the
// `ios/Package.swift` pin, so `swift test` never claims a floor we don't meet.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const SPM_PIN_RE =
  /\.package\s*\(\s*url:\s*"[^"]*\/sentry-cocoa[^"]*"\s*,\s*exact:\s*"([^"]+)"/;
const RN_SENTRY_PIN_RE = /sentry_cocoa_version\s*=\s*['"]([^'"]+)['"]/;

/** @param {string} path @param {RegExp} re */
function extract(path, re) {
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8").match(re)?.[1] ?? null;
}

/** @param {string} a @param {string} b */
function compareVersions(a, b) {
  const pa = a.split(/[.-]/, 3).map(Number);
  const pb = b.split(/[.-]/, 3).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

const spmManifest = join(root, "ios", "Package.swift");
const spmPin = extract(spmManifest, SPM_PIN_RE);
if (!spmPin) {
  console.error(
    `check-sentry-cocoa-pin: no exact sentry-cocoa pin in ${spmManifest}.`
  );
  process.exit(1);
}

const rnSentryPodspec = join(
  root,
  "node_modules",
  "@sentry",
  "react-native",
  "RNSentry.podspec"
);
// Not installed yet (first `prepare` of a fresh install): nothing to compare.
if (!existsSync(rnSentryPodspec)) process.exit(0);

const rnSentryPin = extract(rnSentryPodspec, RN_SENTRY_PIN_RE);
if (!rnSentryPin) {
  console.error(
    `check-sentry-cocoa-pin: no sentry_cocoa_version in ${rnSentryPodspec}.`
  );
  process.exit(1);
}

if (compareVersions(rnSentryPin, spmPin) < 0) {
  console.error(
    `check-sentry-cocoa-pin: @sentry/react-native ships sentry-cocoa ` +
      `${rnSentryPin}, older than the ios/Package.swift floor ${spmPin}.\n` +
      `Raise the @sentry/react-native range or lower the SPM pin.`
  );
  process.exit(1);
}
