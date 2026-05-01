#!/usr/bin/env node
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";

/**
 * Localhost HTTP receiver for bench spans posted by `apps/benchmark/`.
 * Each span is one JSON object on the request body; spans are appended
 * to a per-`runId` NDJSON file under `--out-dir`. After every batch of
 * incoming spans the receiver also rewrites a CSV summary keyed by run
 * id and payload size — useful for at-a-glance comparison across
 * BrowserStack devices when the runner re-uses the same receiver
 * instance for the whole device matrix.
 *
 * Usage:
 *
 *   node scripts/lib/bench-receiver.ts --port 8787 --out-dir ./bench-out
 *
 * BrowserStack runs reach the receiver via `http://localhost:8787` over
 * the BrowserStack Local tunnel. For local dev, point the bench app's
 * UI toggle at `http://<host>:8787/spans`.
 *
 * The receiver is intentionally trivial — no auth, no schema validation
 * beyond JSON parse. It binds to `127.0.0.1` only by default; override
 * with `--host` if you need it reachable from outside localhost (e.g.
 * for a real device on the same LAN — BrowserStack Local takes care of
 * tunneling for managed runs).
 */

type BenchSpan = {
  op: "boot" | "rpc";
  name: string;
  startTimestamp: number;
  durationMs: number;
  attrs?: Record<string, unknown>;
  runId?: string;
};

function parseArgs(argv: string[]): { port: number; host: string; outDir: string } {
  let port = 8787;
  let host = "127.0.0.1";
  let outDir = "./bench-out";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") port = Number(argv[++i]);
    else if (a === "--host") host = String(argv[++i]);
    else if (a === "--out-dir") outDir = String(argv[++i]);
    else if (a === "--help" || a === "-h") {
      console.log(
        "bench-receiver — collects bench spans posted by apps/benchmark\n\n" +
          "Options:\n" +
          "  --port <n>       (default 8787)\n" +
          "  --host <addr>    (default 127.0.0.1)\n" +
          "  --out-dir <dir>  (default ./bench-out)",
      );
      process.exit(0);
    }
  }
  return { port, host, outDir };
}

function safeRunId(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  // Restrict to filename-safe chars: prevents traversal via crafted
  // run ids in untrusted input. Allow alnum + dash + underscore + dot.
  if (!/^[a-zA-Z0-9._-]+$/.test(raw)) return fallback;
  return raw;
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return Number.NaN;
  // Linear interpolation between closest ranks — matches the on-device
  // calculation in apps/benchmark/App.tsx so on-screen and host-side
  // numbers agree.
  const position = (sortedAsc.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedAsc[lower]!;
  const weight = position - lower;
  return sortedAsc[lower]! + (sortedAsc[upper]! - sortedAsc[lower]!) * weight;
}

function rewriteSummary(outDir: string): void {
  const rows: string[] = [["runId", "op", "name", "size", "n", "min", "p50", "p95", "p99", "max"].join(",")];
  for (const file of readdirSync(outDir)) {
    if (!file.endsWith(".ndjson")) continue;
    const runId = file.replace(/\.ndjson$/, "");
    const lines = readFileSync(join(outDir, file), "utf8").split("\n").filter(Boolean);
    /** Buckets keyed by `${op}|${name}|${size}`. */
    const buckets = new Map<string, number[]>();
    for (const line of lines) {
      let span: BenchSpan;
      try {
        span = JSON.parse(line) as BenchSpan;
      } catch {
        continue;
      }
      const sizeAttr = span.attrs && (span.attrs as { bytes?: unknown }).bytes;
      const size = typeof sizeAttr === "number" ? String(sizeAttr) : "";
      const key = `${span.op}|${span.name}|${size}`;
      const arr = buckets.get(key) ?? [];
      arr.push(span.durationMs);
      buckets.set(key, arr);
    }
    for (const [key, durations] of buckets) {
      const [op, name, size] = key.split("|");
      const sorted = [...durations].sort((a, b) => a - b);
      rows.push(
        [
          runId,
          op,
          name,
          size,
          sorted.length,
          sorted[0]!.toFixed(3),
          percentile(sorted, 0.5).toFixed(3),
          percentile(sorted, 0.95).toFixed(3),
          percentile(sorted, 0.99).toFixed(3),
          sorted[sorted.length - 1]!.toFixed(3),
        ].join(","),
      );
    }
  }
  writeFileSync(join(outDir, "summary.csv"), rows.join("\n") + "\n");
}

function readBody(req: IncomingMessage, limit = 16 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function handle(req: IncomingMessage, res: ServerResponse, outDir: string): void {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end("POST only");
    return;
  }

  readBody(req)
    .then((body) => {
      let span: BenchSpan;
      try {
        span = JSON.parse(body) as BenchSpan;
      } catch (e) {
        res.statusCode = 400;
        res.end(`bad json: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      const runId = safeRunId(span.runId, "unknown");
      const file = join(outDir, `${runId}.ndjson`);
      appendFileSync(file, JSON.stringify(span) + "\n");
      // Cheap to recompute on every span — bench runs are bounded
      // (~hundreds of spans per device) and the CSV is the only
      // host-side artifact a human reads.
      rewriteSummary(outDir);
      res.statusCode = 204;
      res.end();
    })
    .catch((e: unknown) => {
      res.statusCode = 500;
      res.end(e instanceof Error ? e.message : String(e));
    });
}

const { port, host, outDir } = parseArgs(process.argv.slice(2));
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

createServer((req, res) => handle(req, res, outDir)).listen(port, host, () => {
  console.log(`bench-receiver listening on http://${host}:${port} → ${outDir}/`);
});
