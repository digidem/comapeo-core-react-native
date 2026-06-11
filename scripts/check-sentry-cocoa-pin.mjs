#!/usr/bin/env node
// Invariant check: the Sentry-Cocoa pin we declare in
// `ios/ComapeoCore.podspec` must satisfy whatever `@sentry/react-native@8.x`'s
// `RNSentry.podspec` resolves to. If they diverge, CocoaPods picks two
// versions and `pod install` fails on the consumer with a useless
// "two versions of Sentry" error — surface that here, at install
// time on this module, so a bump on either side is caught before
// downstream CI runs.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// Match the `s.dependency 'Sentry', '<version-spec>'` line in a
// CocoaPods spec (sentry-cocoa 9 dropped the `HybridSDK` subspec, so
// both our podspec and RNSentry's depend on the plain pod; the
// subspec form is still matched for older layouts). The spec source
// is Ruby; we don't try to parse it fully — just pluck the one
// declaration that matters.
const SENTRY_DEP_RE =
  /s\.dependency\s+['"]Sentry(?:\/HybridSDK)?['"]\s*,\s*['"]([^'"]+)['"]/;
// `@sentry/react-native@8.x` declares the version once as a Ruby
// variable (`sentry_cocoa_version = '9.15.0'`) and references it from
// the dependency line, so the literal-dependency regex finds nothing
// there — fall back to the variable assignment.
const SENTRY_COCOA_VERSION_VAR_RE =
  /sentry_cocoa_version\s*=\s*['"]([^'"]+)['"]/;

/** @param {string} podspecPath */
function extractPin(podspecPath) {
  if (!existsSync(podspecPath)) return null;
  const src = readFileSync(podspecPath, "utf8");
  const match =
    src.match(SENTRY_DEP_RE) ?? src.match(SENTRY_COCOA_VERSION_VAR_RE);
  return match ? match[1] : null;
}

// Match the `.package(url: "...sentry-cocoa...", exact: "X.Y.Z")` line
// in a `Package.swift` manifest. We require `exact:` because the
// bridge uses `@_spi(Private)` symbols whose stability isn't covered
// by semver — a `from:` or `.upToNextMajor` would let SPM resolve to
// a version we haven't validated.
const SENTRY_SPM_DEP_RE =
  /\.package\s*\(\s*url:\s*"[^"]*\/sentry-cocoa[^"]*"\s*,\s*exact:\s*"([^"]+)"/;

/** @param {string} manifestPath */
function extractSpmPin(manifestPath) {
  if (!existsSync(manifestPath)) return null;
  const src = readFileSync(manifestPath, "utf8");
  const match = src.match(SENTRY_SPM_DEP_RE);
  return match ? match[1] : null;
}

// Parses a CocoaPods version requirement (e.g. `~> 8.49.0`) into a
// predicate `(version: string) => boolean`. We support the operators
// CocoaPods actually emits for transitive deps: `~> X.Y.Z` (pessimistic),
// `>= X.Y.Z`, `= X.Y.Z`, and an unadorned version (treated as exact).
/** @param {string} spec */
function compileRequirement(spec) {
  const trimmed = spec.trim();
  const m = trimmed.match(/^(~>|>=|=)\s*(.+)$/);
  const operator = m ? m[1] : "=";
  const target = m ? m[2].trim() : trimmed;
  const targetParts = target.split(".").map(Number);

  return (/** @type {string} */ candidate) => {
    const parts = candidate.trim().split(".").map(Number);
    if (parts.some(Number.isNaN)) return false;
    const cmp = compareVersionParts(parts, targetParts);
    switch (operator) {
      case "=":
        return cmp === 0;
      case ">=":
        return cmp >= 0;
      case "~>": {
        // `~> 8.49.0` matches >= 8.49.0, < 8.50.0
        // `~> 8.49`   matches >= 8.49,   < 9.0
        if (cmp < 0) return false;
        const pessimistic = targetParts.slice(0, -1);
        pessimistic[pessimistic.length - 1] += 1;
        // Append zeros so the comparison length matches.
        while (pessimistic.length < parts.length) pessimistic.push(0);
        return compareVersionParts(parts, pessimistic) < 0;
      }
      default:
        return false;
    }
  };
}

/** @param {number[]} a @param {number[]} b */
function compareVersionParts(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    if (ai < bi) return -1;
    if (ai > bi) return 1;
  }
  return 0;
}

// Our podspec pin: parse from the source of truth so we don't have
// to keep it in sync in two places.
const ourPodspec = join(root, "ios", "ComapeoCore.podspec");
const ourPin = extractPin(ourPodspec);
if (!ourPin) {
  // The Sentry dep was removed from our podspec — that's an explicit
  // intent change, surface it loudly.
  console.error(
    "check-sentry-cocoa-pin: no 'Sentry' dependency in " +
      `${ourPodspec}. Sentry-Cocoa is required.`,
  );
  process.exit(1);
}

// Our SPM pin: `ios/Package.swift` must pin the same Sentry-Cocoa
// version so `swift test` (which links sentry-cocoa directly) and
// `pod install` (which links it via CocoaPods) end up with the same
// build of the SPI surface our bridge uses. Drift between the two
// produces hard-to-debug behaviour differences between the SPM test
// target and on-device pod builds.
const ourSpmManifest = join(root, "ios", "Package.swift");
const ourSpmPin = extractSpmPin(ourSpmManifest);
if (!ourSpmPin) {
  console.error(
    "check-sentry-cocoa-pin: no 'sentry-cocoa' SPM dependency in " +
      `${ourSpmManifest}. The SPM target needs Sentry-Cocoa so the ` +
      "macOS test build resolves `import Sentry` cleanly.",
  );
  process.exit(1);
}
if (ourSpmPin !== ourPin.replace(/^(~>|>=|=)\s*/, "").trim()) {
  console.error(
    `check-sentry-cocoa-pin: pod and SPM pins disagree.\n` +
      `  ios/ComapeoCore.podspec:  ${ourPin}\n` +
      `  ios/Package.swift:        exact ${ourSpmPin}\n` +
      `\n` +
      `Pin both to the same Sentry-Cocoa version.`,
  );
  process.exit(1);
}

// `@sentry/react-native`'s pin: only check if the package is actually
// installed. Standalone `npm install` of this package in a workspace
// that hasn't laid out its node_modules yet (or during the very
// `prepare` script that runs on first install) may not have it.
const rnSentryPodspec = join(
  root,
  "node_modules",
  "@sentry",
  "react-native",
  "RNSentry.podspec",
);
const rnSentryPin = extractPin(rnSentryPodspec);
if (rnSentryPin === null) {
  // Not installed yet — silently skip. The check will run again on
  // the next `prepare` once the consumer's install completes.
  process.exit(0);
}

const ourPredicate = compileRequirement(ourPin);
// `rnSentryPin` is itself a requirement string. We need a concrete
// version to test against. Extract the operand and feed it to our
// predicate — if the operand alone doesn't satisfy our pin, neither
// will any version CocoaPods picks within the range, so this is a
// sufficient check for the common-case mismatch.
const rnSentryOperand = rnSentryPin.replace(/^(~>|>=|=)\s*/, "").trim();
if (!ourPredicate(rnSentryOperand)) {
  console.error(
    `check-sentry-cocoa-pin: Sentry-Cocoa pin mismatch.\n` +
      `  ours (ios/ComapeoCore.podspec):                 ${ourPin}\n` +
      `  @sentry/react-native RNSentry.podspec:          ${rnSentryPin}\n` +
      `\n` +
      `These must overlap so CocoaPods deduplicates to a single ` +
      `Sentry pod. Bump one or the other in lockstep.`,
  );
  process.exit(1);
}
