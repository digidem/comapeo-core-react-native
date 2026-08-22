#!/usr/bin/env node

// Prints a benchmark results file, or compares two of them.
//
// Usage:
//   node scripts/benchmark-report.mjs benchmark-results/after.json
//   node scripts/benchmark-report.mjs benchmark-results/before.json \
//                                     benchmark-results/after.json
//
// Reports medians rather than means: boot measurements are skewed by the
// occasional scheduling stall, and one stalled boot would drag a mean around.
// The p-values are two-sided Mann–Whitney U over the individual boots — they
// say whether these two sets of boots differ, not whether the effect holds on
// hardware you did not test.

import fs from "node:fs";

import {
  METRICS,
  compare,
  perRoundMedians,
  summarise,
} from "./lib/benchmark-core.mjs";

const files = process.argv.slice(2);
if (files.length === 0 || files.length > 2) {
  console.error("Usage: benchmark-report.mjs <results.json> [<results.json>]");
  process.exit(1);
}

const series = files.map((file) => {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  return { file, ...parsed, summary: summarise(parsed.runs) };
});

const num = (value, digits = 1) =>
  value == null ? "—" : value.toFixed(digits);
const pad = (text, width) => String(text).padStart(width);
const padEnd = (text, width) => String(text).padEnd(width);

function header(entry) {
  const { summary } = entry;
  const runtime = summary.runtime ? `nodejs-mobile ${summary.runtime}` : "runtime unknown";
  const failed = summary.failed ? `, ${summary.failed} failed` : "";
  return `${entry.label}: ${summary.count} boots${failed} · ${runtime}`;
}

if (series.length === 1) {
  const [only] = series;
  console.log(`\n${header(only)}\n`);
  console.log(padEnd("metric", 22) + pad("median", 10) + pad("sd", 9) + pad("n", 5));
  console.log("-".repeat(46));
  for (const metric of METRICS) {
    const stats = only.summary.metrics[metric.key];
    if (!stats || stats.median == null) continue;
    console.log(
      padEnd(`${metric.label} (${metric.unit})`, 22) +
        pad(num(stats.median, metric.unit === "s" ? 2 : 1), 10) +
        pad(num(stats.stdev, 2), 9) +
        pad(stats.n, 5),
    );
  }
  console.log();
  process.exit(0);
}

const [baseline, candidate] = series;
console.log(`\nbaseline  ${header(baseline)}`);
console.log(`candidate ${header(candidate)}\n`);

const rows = compare(baseline.summary, candidate.summary);
console.log(
  padEnd("metric", 22) +
    pad("baseline", 11) +
    pad("candidate", 11) +
    pad("delta", 10) +
    pad("%", 8) +
    pad("p", 9),
);
console.log("-".repeat(71));
for (const row of rows) {
  if (row.baseline == null && row.candidate == null) continue;
  const digits = row.unit === "s" ? 2 : 1;
  console.log(
    padEnd(`${row.label} (${row.unit})`, 22) +
      pad(num(row.baseline, digits), 11) +
      pad(num(row.candidate, digits), 11) +
      pad(num(row.delta, digits), 10) +
      pad(num(row.percent, 1), 8) +
      pad(row.p == null ? "—" : row.p < 0.001 ? "<0.001" : row.p.toFixed(3), 9),
  );
}

// Per-round medians are the check that matters on a busy machine: if the two
// builds separate the same way in every round, the difference is the build
// and not drift in host load across the session.
const rounds = new Set(baseline.runs.concat(candidate.runs).map((run) => run.round));
if (rounds.size > 1) {
  console.log("\nper-round medians (peak RSS, MB):");
  console.log(padEnd("round", 10) + pad("baseline", 11) + pad("candidate", 11));
  const a = perRoundMedians(baseline.runs, "peakRss");
  const b = perRoundMedians(candidate.runs, "peakRss");
  for (const round of [...rounds].sort((x, y) => x - y)) {
    console.log(
      padEnd(round, 10) +
        pad(num(a.find((r) => r.round === round)?.median), 11) +
        pad(num(b.find((r) => r.round === round)?.median), 11),
    );
  }
}
console.log();
