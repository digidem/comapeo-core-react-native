#!/usr/bin/env node

// Turns the raw per-boot artefacts pulled off the device by
// scripts/benchmark-boot.sh into one results JSON per labelled series.
//
// Usage:
//   node scripts/benchmark-collect.mjs --raw <dir> --label <label> --out <file>
//
// The raw directory holds, per boot id: <id>.log (logcat -v epoch) and
// <id>.meta (host-side launch timestamp + pid).

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { bootDurations, parseLogcat, parseRunId } from "./lib/benchmark-core.mjs";

const { values } = parseArgs({
  options: {
    raw: { type: "string" },
    label: { type: "string" },
    out: { type: "string" },
  },
});
for (const key of ["raw", "label", "out"]) {
  if (!values[key]) {
    console.error(`Missing required --${key}`);
    process.exit(1);
  }
}
const { raw, label, out } = values;

function readIfPresent(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Boot ids for this label, in run order: `<label>-r<round>-<index>`. */
const entries = fs
  .readdirSync(raw)
  .filter((name) => name.endsWith(".meta"))
  .map((name) => name.replace(/\.meta$/, ""))
  .map((id) => ({ id, ...parseRunId(id, label) }))
  .filter((entry) => entry.round !== undefined)
  .sort((a, b) => a.round - b.round || a.index - b.index);

const runs = entries.map(({ id, round, index }) => {
  const meta = Object.fromEntries(
    (readIfPresent(path.join(raw, `${id}.meta`)) ?? "")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("=")),
  );
  const logcat = readIfPresent(path.join(raw, `${id}.log`)) ?? "";
  const { milestones, memory } = parseLogcat(logcat);
  const t0 = Number(meta.t0_epoch);
  const durations = Number.isFinite(t0) ? bootDurations(milestones, t0) : {};

  // A boot with no `ready` never got the backend up; a boot with no memory
  // snapshot got there but died (or stalled) before reporting. Both are
  // failures for comparison purposes, and both are worth surfacing rather
  // than quietly averaging away.
  const failed = durations.ready === undefined || !memory;

  return { id, label, round, index, failed, durations, memory };
});

const failures = runs.filter((run) => run.failed);
if (failures.length) {
  console.warn(
    `==> ${label}: ${failures.length}/${runs.length} boots did not reach a memory sample (${failures
      .map((run) => run.id)
      .join(", ")})`,
  );
}

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(
  out,
  `${JSON.stringify({ label, capturedAt: new Date().toISOString(), runs }, null, 2)}\n`,
);
console.log(`==> ${label}: ${runs.length - failures.length} usable boots → ${out}`);
