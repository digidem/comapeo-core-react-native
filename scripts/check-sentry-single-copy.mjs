#!/usr/bin/env node
// Fails when backend/package-lock.json holds a runtime `@sentry/*` package at
// more than one version (see `lib/sentry-duplicates.mjs` for why that breaks).

import { readFileSync } from "node:fs";

import { findDuplicateSentryPackages } from "./lib/sentry-duplicates.mjs";

const lockPath = new URL("../backend/package-lock.json", import.meta.url);
const duplicates = findDuplicateSentryPackages(
  JSON.parse(readFileSync(lockPath, "utf8"))
);

if (duplicates.size > 0) {
  const lines = [...duplicates].map(
    ([name, versions]) => `  ${name}: ${versions.join(", ")}`
  );
  console.error(
    "check-sentry-single-copy: backend/package-lock.json has more than one " +
      "version of:\n" +
      lines.join("\n") +
      "\n\nAlign the @sentry/* versions in backend/ (npm can stop short of " +
      "the newest when a package's `latest` dist-tag lags)."
  );
  process.exit(1);
}
