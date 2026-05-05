/**
 * Host-side HTTP receiver for bench spans.
 *
 * Pairs with the bench app's "POST spans" toggle (default URL
 * `http://localhost:8787/spans`). For BrowserStack runs the device
 * reaches this through a BrowserStack Local tunnel — start the
 * `BrowserStackLocal --key $BROWSERSTACK_ACCESS_KEY --daemon start`
 * tunnel and point the bench app at the same localhost URL.
 *
 * Each span POST is appended to `<outDir>/<runId>.ndjson`. The runId
 * is taken from the body the bench app already attaches (`App.tsx`
 * generates `${Date.now()}-${random()}` per Run-benchmark tap), so
 * spans from a single tap land in a single file across devices that
 * happen to share a runId only by collision (vanishingly rare).
 *
 * Deliberately minimal: no auth, no rate limit, no schema validation
 * beyond "has a string runId." Treat it as a localhost development
 * tool; don't bind a public interface.
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { mkdir, appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));

const PORT = Number(process.env.BENCH_RECEIVER_PORT ?? 8787);
const OUT_DIR = resolve(
  PROJECT_ROOT,
  process.env.BENCH_RECEIVER_OUT_DIR ?? "apps/benchmark/results",
);

await mkdir(OUT_DIR, { recursive: true });

let acceptedCount = 0;
let rejectedCount = 0;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * runId chars are ASCII alphanumerics + dash by construction in
 * App.tsx (`${Date.now()}-${random.toString(36)}`). Reject anything
 * else so a malformed POST can't write outside `OUT_DIR` via path
 * traversal.
 */
function isSafeRunId(s: unknown): s is string {
  return typeof s === "string" && s.length > 0 && s.length <= 64 && /^[a-zA-Z0-9_-]+$/.test(s);
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(`ok accepted=${acceptedCount} rejected=${rejectedCount}\n`);
      return;
    }

    if (req.method === "POST" && req.url === "/spans") {
      const body = await readBody(req);
      let span: Record<string, unknown>;
      try {
        span = JSON.parse(body);
      } catch {
        rejectedCount++;
        respondJson(res, 400, { error: "invalid JSON" });
        return;
      }
      if (!isSafeRunId(span.runId)) {
        rejectedCount++;
        respondJson(res, 400, { error: "missing or invalid runId" });
        return;
      }
      const filePath = join(OUT_DIR, `${span.runId}.ndjson`);
      await appendFile(filePath, JSON.stringify(span) + "\n");
      acceptedCount++;
      respondJson(res, 202, { ok: true });
      return;
    }

    respondJson(res, 404, { error: "not found" });
  } catch (e) {
    console.error("bench-receiver: handler error", e);
    if (!res.headersSent) {
      respondJson(res, 500, { error: "internal" });
    }
  }
});

function respondJson(res: ServerResponse, status: number, body: object) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body) + "\n");
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `bench-receiver listening on http://127.0.0.1:${PORT}\n` +
      `  POST /spans → append to ${OUT_DIR}/<runId>.ndjson\n` +
      `  GET  /health → liveness probe`,
  );
});

const shutdown = (sig: string) => () => {
  console.log(`\nbench-receiver: ${sig} — shutting down (accepted=${acceptedCount} rejected=${rejectedCount})`);
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown("SIGINT"));
process.on("SIGTERM", shutdown("SIGTERM"));
