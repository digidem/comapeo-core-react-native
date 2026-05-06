/**
 * Reads NDJSON span files written by `scripts/bench-receiver.ts`,
 * groups by `attrs.device`, computes percentiles per (op, name, size),
 * and rewrites the AUTOSUMMARY-marked section of
 * `apps/benchmark/RESULTS.md`.
 *
 * One pass over all `<resultsDir>/*.ndjson` (default
 * `apps/benchmark/results/`). RPC and boot spans are aggregated
 * separately:
 *   - `op:"rpc"` rows are bucketed by `attrs.bytes` (size class);
 *     percentiles over `durationMs`.
 *   - `op:"boot"` rows are bucketed by `name` (`boot.<phase>`);
 *     a single duration measurement per phase per session, so we
 *     report min / median / max across sessions for the same
 *     device.
 *
 * The generated section is delimited by:
 *
 *   <!-- BEGIN AUTOSUMMARY -->
 *   <!-- END AUTOSUMMARY -->
 *
 * Anything outside that envelope is preserved verbatim — which is
 * how curated commentary and per-run notes survive subsequent
 * summarizer runs.
 *
 * Usage:
 *   node scripts/bench-summarize.ts [--results-dir <path>] [--results-md <path>]
 */

import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));

type Args = {
  resultsDir: string;
  resultsMd: string;
};

function parseArgs(): Args {
  const out: Args = {
    resultsDir: path.join(PROJECT_ROOT, "apps/benchmark/results"),
    resultsMd: path.join(PROJECT_ROOT, "apps/benchmark/RESULTS.md"),
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    switch (a) {
      case "--results-dir":
        out.resultsDir = path.resolve(v); i++; break;
      case "--results-md":
        out.resultsMd = path.resolve(v); i++; break;
      case "--help":
      case "-h":
        console.log("usage: node scripts/bench-summarize.ts [--results-dir <path>] [--results-md <path>]");
        process.exit(0);
    }
  }
  return out;
}

type Span = {
  op: "rpc" | "boot";
  name: string;
  durationMs: number;
  startTimestamp: number;
  attrs?: { bytes?: number; device?: string; [k: string]: unknown };
  runId?: string;
};

function percentile(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  const pos = (n - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, n - 1);
  const w = pos - lo;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * w;
}

function fmtMs(v: number): string {
  if (!Number.isFinite(v)) return "–";
  if (v < 10) return v.toFixed(2);
  return v.toFixed(1);
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(0)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

async function loadAllSpans(dir: string): Promise<Span[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const spans: Span[] = [];
  for (const e of entries) {
    if (!e.endsWith(".ndjson")) continue;
    const p = path.join(dir, e);
    const s = await stat(p);
    if (!s.isFile()) continue;
    const text = await readFile(p, "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        spans.push(JSON.parse(line));
      } catch {
        // Tolerate a partial trailing line (writer crash mid-flush);
        // every full span before it is still usable.
      }
    }
  }
  return spans;
}

type DeviceKey = string;

/**
 * Per-device, per-size RPC table row.
 */
type RpcRow = {
  device: DeviceKey;
  size: number;
  n: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
};

/**
 * Per-device, per-phase boot table row. With multiple sessions per
 * device, each phase has multiple measurements, so report a min /
 * median / max instead of the RPC-style p99.
 */
type BootRow = {
  device: DeviceKey;
  phase: string;
  n: number;
  min: number;
  median: number;
  max: number;
};

function summarizeRpc(spans: Span[]): RpcRow[] {
  const buckets = new Map<string, number[]>();
  for (const s of spans) {
    if (s.op !== "rpc") continue;
    const dev = s.attrs?.device ?? "unknown";
    const sz = s.attrs?.bytes;
    if (typeof sz !== "number") continue;
    const key = `${dev}\t${sz}`;
    let arr = buckets.get(key);
    if (!arr) {
      arr = [];
      buckets.set(key, arr);
    }
    arr.push(s.durationMs);
  }
  const rows: RpcRow[] = [];
  for (const [key, arr] of buckets) {
    const [device, sizeStr] = key.split("\t");
    const sorted = [...arr].sort((a, b) => a - b);
    rows.push({
      device: device!,
      size: Number(sizeStr),
      n: sorted.length,
      min: sorted[0]!,
      max: sorted[sorted.length - 1]!,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
    });
  }
  rows.sort((a, b) => a.device.localeCompare(b.device) || a.size - b.size);
  return rows;
}

function summarizeBoot(spans: Span[]): BootRow[] {
  const buckets = new Map<string, number[]>();
  for (const s of spans) {
    if (s.op !== "boot") continue;
    const dev = s.attrs?.device ?? "unknown";
    const key = `${dev}\t${s.name}`;
    let arr = buckets.get(key);
    if (!arr) {
      arr = [];
      buckets.set(key, arr);
    }
    arr.push(s.durationMs);
  }
  const rows: BootRow[] = [];
  for (const [key, arr] of buckets) {
    const [device, phase] = key.split("\t");
    const sorted = [...arr].sort((a, b) => a - b);
    rows.push({
      device: device!,
      phase: phase!,
      n: sorted.length,
      min: sorted[0]!,
      median: percentile(sorted, 0.5),
      max: sorted[sorted.length - 1]!,
    });
  }
  rows.sort((a, b) => a.device.localeCompare(b.device) || a.phase.localeCompare(b.phase));
  return rows;
}

function renderRpcTable(rows: RpcRow[]): string {
  if (rows.length === 0) return "_(no rpc spans found)_\n";
  const lines: string[] = [];
  lines.push("| device | size | n | min | p50 | p95 | p99 | max |");
  lines.push("|---|---|---:|---:|---:|---:|---:|---:|");
  for (const r of rows) {
    lines.push(
      `| ${r.device} | ${fmtBytes(r.size)} | ${r.n} | ${fmtMs(r.min)} | ${fmtMs(r.p50)} | ${fmtMs(r.p95)} | ${fmtMs(r.p99)} | ${fmtMs(r.max)} |`,
    );
  }
  return lines.join("\n") + "\n";
}

function renderBootTable(rows: BootRow[]): string {
  if (rows.length === 0) return "_(no boot spans found)_\n";
  const lines: string[] = [];
  lines.push("| device | phase | n | min | median | max |");
  lines.push("|---|---|---:|---:|---:|---:|");
  for (const r of rows) {
    lines.push(
      `| ${r.device} | ${r.phase} | ${r.n} | ${fmtMs(r.min)} | ${fmtMs(r.median)} | ${fmtMs(r.max)} |`,
    );
  }
  return lines.join("\n") + "\n";
}

async function rewriteResultsMd(args: Args, body: string) {
  const md = await readFile(args.resultsMd, "utf8");
  const begin = "<!-- BEGIN AUTOSUMMARY -->";
  const end = "<!-- END AUTOSUMMARY -->";
  const beginIdx = md.indexOf(begin);
  const endIdx = md.indexOf(end);
  let next: string;
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    // First-time write: append the section to the bottom. Subsequent
    // runs will rewrite in-place via the markers.
    next = md.replace(/\s+$/, "") + "\n\n" + begin + "\n" + body + end + "\n";
  } else {
    next = md.slice(0, beginIdx + begin.length) + "\n" + body + md.slice(endIdx);
  }
  await writeFile(args.resultsMd, next, "utf8");
}

async function main() {
  const args = parseArgs();
  const spans = await loadAllSpans(args.resultsDir);
  const rpc = summarizeRpc(spans);
  const boot = summarizeBoot(spans);

  const generatedAt = new Date().toISOString();
  const devices = new Set([
    ...rpc.map((r) => r.device),
    ...boot.map((r) => r.device),
  ]);

  const body =
    `_Generated by \`scripts/bench-summarize.ts\` from ` +
    `\`${path.relative(PROJECT_ROOT, args.resultsDir)}/\` at ` +
    `${generatedAt} — ${spans.length} spans across ${devices.size} ` +
    `device${devices.size === 1 ? "" : "s"}._\n\n` +
    "#### RPC throughput (RN-thread RTT, ms)\n\n" +
    renderRpcTable(rpc) +
    "\n#### Boot phases (server-side, ms)\n\n" +
    renderBootTable(boot) +
    "\n";

  await rewriteResultsMd(args, body);
  console.log(
    `bench-summarize: ${spans.length} spans → ${devices.size} device(s) → ${path.relative(PROJECT_ROOT, args.resultsMd)}`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
