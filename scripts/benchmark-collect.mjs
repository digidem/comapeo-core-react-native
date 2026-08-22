#!/usr/bin/env node

// Turns the raw per-boot artefacts pulled off the device by
// scripts/benchmark-boot.sh into one results JSON per labelled series.
//
// Usage:
//   node scripts/benchmark-collect.mjs --raw <dir> --label <label> --out <file>
//
// The raw directory holds, per boot id: <id>.log (logcat -v epoch),
// <id>.meta (host-side launch timestamp + pid), <id>.meminfo (dumpsys), and
// optionally <id>.timeline (50 ms /proc samples, root only).

import fs from "node:fs";
import path from "node:path";

import {
  bootDurations,
  parseLogcat,
  parseMeminfoPss,
  parseProcTimeline,
} from "./lib/benchmark-core.mjs";

function parseArgs(argv) {
  const args = { raw: null, label: null, out: null };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, "");
    if (!(key in args)) {
      console.error(`Unknown option: ${argv[i]}`);
      process.exit(1);
    }
    args[key] = argv[i + 1];
  }
  for (const [key, value] of Object.entries(args)) {
    if (!value) {
      console.error(`Missing required --${key}`);
      process.exit(1);
    }
  }
  return args;
}

const { raw, label, out } = parseArgs(process.argv.slice(2));

function readIfPresent(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Boot ids for this label, in run order: `<label>-r<round>-<index>`. */
const ids = fs
  .readdirSync(raw)
  .filter((name) => name.endsWith(".meta"))
  .map((name) => name.replace(/\.meta$/, ""))
  .filter((id) => id.startsWith(`${label}-r`))
  .sort((a, b) => {
    const parse = (id) => id.match(/-r(\d+)-(\d+)$/).slice(1, 3).map(Number);
    const [ra, ia] = parse(a);
    const [rb, ib] = parse(b);
    return ra - rb || ia - ib;
  });

const runs = ids.map((id) => {
  const meta = Object.fromEntries(
    (readIfPresent(path.join(raw, `${id}.meta`)) ?? "")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("=")),
  );
  const [, round, index] = id.match(/-r(\d+)-(\d+)$/).map(Number);
  const logcat = readIfPresent(path.join(raw, `${id}.log`)) ?? "";
  const { milestones, memory } = parseLogcat(logcat);
  const t0 = Number(meta.t0_epoch);
  const durations = Number.isFinite(t0) ? bootDurations(milestones, t0) : {};
  const timelineText = readIfPresent(path.join(raw, `${id}.timeline`));
  const meminfoText = readIfPresent(path.join(raw, `${id}.meminfo`));

  // A boot with no `ready` never got the backend up; a boot with no memory
  // snapshot got there but died (or stalled) before reporting. Both are
  // failures for comparison purposes, and both are worth surfacing rather
  // than quietly averaging away.
  const failed = durations.ready === undefined || !memory;

  return {
    id,
    label,
    round,
    index,
    failed,
    alive: meta.alive === "1",
    durations,
    memory,
    pssBytes: meminfoText ? parseMeminfoPss(meminfoText) : null,
    timeline: timelineText ? parseProcTimeline(timelineText) : null,
  };
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
