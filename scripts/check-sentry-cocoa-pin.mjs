#!/usr/bin/env node
// Invariant check: the Sentry-Cocoa pin we declare in
// `ios/ComapeoCore.podspec` must satisfy whatever `@sentry/react-native@7.x`'s
// `RNSentry.podspec` resolves to. If they diverge, CocoaPods picks two
// versions and `pod install` fails on the consumer with a useless
// "two versions of Sentry/HybridSDK" error — surface that here, at
// install time on this module, so a bump on either side is caught
// before downstream CI runs.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// Match the `s.dependency 'Sentry/HybridSDK', '<version-spec>'` line
// in a CocoaPods spec. The spec source is Ruby; we don't try to
// parse it fully — just pluck the one declaration that matters.
const SENTRY_HYBRID_DEP_RE =
  /s\.dependency\s+['"]Sentry\/HybridSDK['"]\s*,\s*['"]([^'"]+)['"]/;

function extractPin(podspecPath) {
  if (!existsSync(podspecPath)) return null;
  const src = readFileSync(podspecPath, "utf8");
  const match = src.match(SENTRY_HYBRID_DEP_RE);
  return match ? match[1] : null;
}

// Parses a CocoaPods version requirement (e.g. `~> 8.49.0`) into a
// predicate `(version: string) => boolean`. We support the operators
// CocoaPods actually emits for transitive deps: `~> X.Y.Z` (pessimistic),
// `>= X.Y.Z`, `= X.Y.Z`, and an unadorned version (treated as exact).
function compileRequirement(spec) {
  const trimmed = spec.trim();
  const m = trimmed.match(/^(~>|>=|=)\s*(.+)$/);
  const operator = m ? m[1] : "=";
  const target = m ? m[2].trim() : trimmed;
  const targetParts = target.split(".").map(Number);

  return (candidate) => {
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

// Our pin: parse from the source of truth so we don't have to keep
// it in sync in two places.
const ourPodspec = join(root, "ios", "ComapeoCore.podspec");
const ourPin = extractPin(ourPodspec);
if (!ourPin) {
  // The Sentry dep was removed from our podspec — that's an explicit
  // intent change, surface it loudly.
  console.error(
    "check-sentry-cocoa-pin: no 'Sentry/HybridSDK' dependency in " +
      `${ourPodspec}. Sentry-Cocoa is required.`,
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
