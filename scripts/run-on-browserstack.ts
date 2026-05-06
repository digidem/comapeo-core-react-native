/**
 * BrowserStack App Automate runner for the bench Maestro flows.
 * Uploads app + Maestro test suite, dispatches one or more builds
 * (auto-batched against the account's parallel+queued cap), waits
 * for terminal status, pulls device logs, and parses `BENCH_SPAN`
 * lines into NDJSON under `apps/benchmark/results/`.
 *
 * Usage:
 *   node --env-file=.env scripts/run-on-browserstack.ts \
 *     --app-android <path-to.apk> \
 *     [--app-ios <path-to.ipa>] \
 *     [--flow bench-rpc.yaml] \
 *     [--device-android "Pixel 10 Pro-16.0"] \
 *     [--devices-android "<csv>"] \
 *     [--device-ios "iPhone 15-17"] \
 *     [--devices-ios "<csv>"] \
 *     [--build-name <static name>] \
 *     [--build-identifier <e.g. ${BUILD_NUMBER}>] \
 *     [--build-tag <free-form filter tag>] \
 *     [--project <existing BrowserStack project name>] \
 *     [--maestro-version <2.0.7|latest|1.39.13>]
 *
 * Defaults: Android device list is `CURATED_ANDROID_DEVICES` below
 * (10 devices spanning Android 9–16 across 6 brands, fits one BS
 * 5+5 plan dispatch). Override singly with `--device-android` or
 * via CSV with `--devices-android`.
 *
 * `BENCH_BROWSERSTACK_PROJECT` env var supplies the project default
 * for accounts whose access key can't auto-create projects (HTTP 422
 * "create this project" error).
 *
 * API references:
 *   https://www.browserstack.com/docs/app-automate/api-reference/maestro/apps
 *   https://www.browserstack.com/docs/app-automate/api-reference/maestro/tests
 *   https://www.browserstack.com/docs/app-automate/api-reference/maestro/builds
 *   https://www.browserstack.com/docs/test-reporting-and-analytics/how-to-guides/organize-test-runs
 */

import { mkdtemp, rm, copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const FLOWS_SRC_DIR = path.join(PROJECT_ROOT, "apps/benchmark/.maestro");
const RESULTS_DIR = path.join(PROJECT_ROOT, "apps/benchmark/results");

const API = "https://api-cloud.browserstack.com/app-automate/maestro/v2";
const PLAN_API = "https://api-cloud.browserstack.com/app-automate/plan.json";

/**
 * Default Android device sweep. Picked across the BS catalog to span
 * Android 9–16 and the variance spectrum (recent flagship → older
 * budget). Sized to fit one dispatch on a 5-parallel + 5-queued plan.
 */
const CURATED_ANDROID_DEVICES = [
  "Samsung Galaxy S26 Ultra-16.0",
  "Google Pixel 10 Pro-16.0",
  "OnePlus 13R-15.0",
  "OnePlus 12R-14.0",
  "Google Pixel 7-13.0",
  "Samsung Galaxy S22-12.0",
  "Xiaomi Redmi Note 11-11.0",
  "Vivo Y21-11.0",
  "Samsung Galaxy A51-10.0",
  "Huawei P30-9.0",
];

const DEFAULT_IOS_DEVICE = "iPhone 15-17";

/**
 * Maestro version pin. BS supports `latest`, `1.39.13` (current
 * default), and `2.0.7`. We pin 2.0.7 for the runner-side `http`
 * client and the perf fixes; floating to `latest` would risk a
 * surprise bump.
 */
const MAESTRO_VERSION = "2.0.7";

const CUSTOM_ID = {
  android: "comapeo-bench-android",
  ios: "comapeo-bench-ios",
  testSuite: "comapeo-bench-flows",
};

type Platform = "android" | "ios";

type CliArgs = {
  appAndroid?: string;
  appIos?: string;
  flow: string;
  devicesAndroid: string[];
  devicesIos: string[];
  customBuildName: string;
  buildIdentifier: string;
  buildTag?: string;
  project?: string;
  maestroVersion: string;
};

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const out: CliArgs = {
    flow: "bench-rpc.yaml",
    devicesAndroid: CURATED_ANDROID_DEVICES,
    devicesIos: [DEFAULT_IOS_DEVICE],
    // Static `customBuildName` keeps Test Reporting & Analytics able
    // to draw trend lines across runs. `buildIdentifier` is the
    // per-run differentiator. Both are overridable via flags.
    customBuildName: "comapeo-bench",
    buildIdentifier: new Date().toISOString().replace(/[:.]/g, "-"),
    project: process.env.BENCH_BROWSERSTACK_PROJECT,
    maestroVersion: MAESTRO_VERSION,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const v = args[i + 1];
    switch (a) {
      case "--app-android":
        out.appAndroid = v; i++; break;
      case "--app-ios":
        out.appIos = v; i++; break;
      case "--flow":
        out.flow = v; i++; break;
      case "--device-android":
      case "--devices-android":
        out.devicesAndroid = parseDeviceList(v); i++; break;
      case "--device-ios":
      case "--devices-ios":
        out.devicesIos = parseDeviceList(v); i++; break;
      case "--build-name":
        out.customBuildName = v; i++; break;
      case "--build-identifier":
        out.buildIdentifier = v; i++; break;
      case "--build-tag":
        out.buildTag = v; i++; break;
      case "--project":
        out.project = v; i++; break;
      case "--maestro-version":
        out.maestroVersion = v; i++; break;
      case "--help":
      case "-h":
        printUsageAndExit(0);
      default:
        if (a?.startsWith("--")) {
          console.error(`Unknown arg: ${a}`);
          printUsageAndExit(1);
        }
    }
  }
  if (!out.appAndroid && !out.appIos) {
    console.error("error: provide at least one of --app-android <apk> or --app-ios <ipa>");
    printUsageAndExit(1);
  }
  return out;
}

function parseDeviceList(v: string | undefined): string[] {
  if (!v) return [];
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

function printUsageAndExit(code: number): never {
  console.log(
    "usage: node --env-file=.env scripts/run-on-browserstack.ts \\\n" +
      "    --app-android <path.apk> \\\n" +
      "    [--app-ios <path.ipa>] \\\n" +
      "    [--flow bench-rpc.yaml] \\\n" +
      "    [--devices-android \"<csv>\"] \\\n" +
      "    [--devices-ios \"<csv>\"] \\\n" +
      "    [--build-name <static>] \\\n" +
      "    [--build-identifier <per-run>] \\\n" +
      "    [--build-tag <filter>] \\\n" +
      "    [--project <existing>] \\\n" +
      "    [--maestro-version <2.0.7|latest|1.39.13>]",
  );
  process.exit(code);
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`error: ${name} not set. Copy .env.example to .env and fill it in, then re-run with \`node --env-file=.env\`.`);
    process.exit(1);
  }
  return v;
}

let cachedAuthHeader: string | null = null;
function authHeader(): string {
  if (cachedAuthHeader === null) {
    const user = requireEnv("BROWSERSTACK_USERNAME");
    const key = requireEnv("BROWSERSTACK_ACCESS_KEY");
    cachedAuthHeader = `Basic ${Buffer.from(`${user}:${key}`).toString("base64")}`;
  }
  return cachedAuthHeader;
}

async function fileExists(p: string) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function bsFetch(url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: authHeader(),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new Error(
      `BrowserStack ${init.method ?? "GET"} ${url} → ${res.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`,
    );
  }
  return body as Record<string, unknown>;
}

async function uploadMultipart(
  pathname: string,
  filePath: string,
  formFields: Record<string, string>,
): Promise<Record<string, unknown>> {
  const boundary = `----comapeo-bench-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const fileBuf = await readFileAsBuffer(filePath);
  const filename = path.basename(filePath);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(formFields)) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
    ));
  }
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  ));
  parts.push(fileBuf);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  const body = Buffer.concat(parts);
  return bsFetch(`${API}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
  });
}

async function readFileAsBuffer(p: string): Promise<Buffer> {
  return new Promise((resolveBuf, reject) => {
    const chunks: Buffer[] = [];
    const stream = createReadStream(p);
    stream.on("data", (c: string | Buffer) => chunks.push(typeof c === "string" ? Buffer.from(c) : c));
    stream.on("end", () => resolveBuf(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

async function uploadApp(filePath: string, customId: string) {
  console.log(`  → upload ${path.basename(filePath)} (custom_id=${customId})…`);
  const r = await uploadMultipart("/app", filePath, { custom_id: customId });
  const appUrl = r.app_url as string;
  if (!appUrl) throw new Error(`unexpected upload response: ${JSON.stringify(r)}`);
  console.log(`    ${appUrl}`);
  return appUrl;
}

async function uploadTestSuite(zipPath: string, customId: string) {
  console.log(`  → upload ${path.basename(zipPath)} (custom_id=${customId})…`);
  const r = await uploadMultipart("/test-suite", zipPath, { custom_id: customId });
  const testSuiteUrl = r.test_suite_url as string;
  if (!testSuiteUrl) throw new Error(`unexpected upload response: ${JSON.stringify(r)}`);
  console.log(`    ${testSuiteUrl}`);
  return testSuiteUrl;
}

/**
 * Returns the account's max devices per dispatch (parallel+queued).
 * Falls back to 5 if the plan endpoint changes shape, since 5 is the
 * floor on free/starter plans.
 */
async function fetchPlanCapacity(): Promise<number> {
  try {
    const r = await bsFetch(PLAN_API);
    const parallel = Number(r.parallel_sessions_max_allowed) || 0;
    const queued = Number(r.queued_sessions_max_allowed) || 0;
    if (parallel + queued > 0) return parallel + queued;
  } catch (e) {
    console.warn(`warn: could not query plan limits (${e instanceof Error ? e.message : e}); defaulting to 5`);
  }
  return 5;
}

type BuildArgs = {
  platform: Platform;
  appUrl: string;
  testSuiteUrl: string;
  devices: string[];
  flow: string;
  customBuildName: string;
  buildIdentifier: string;
  buildTag?: string;
  project?: string;
  maestroVersion: string;
};

async function triggerBuild(args: BuildArgs): Promise<string> {
  const body: Record<string, unknown> = {
    app: args.appUrl,
    testSuite: args.testSuiteUrl,
    devices: args.devices,
    // `execute` is RELATIVE to the zip's parent dir — BS auto-
    // prepends the parent at extract time. So `bench-rpc.yaml` (no
    // `flows/` prefix) resolves correctly.
    execute: [args.flow],
    // Capture device logs and network HAR for every run; these are
    // off by default on BS. Span data flows through the device log
    // (LogSink in the bench backend + RN-side console.log emit
    // BENCH_SPAN-prefixed lines that we grep post-build), so device
    // logs are essential, not optional.
    deviceLogs: true,
    networkLogs: true,
    // Test R&A organization. Static `customBuildName` makes the
    // build show up in the same trend line each run; `buildIdentifier`
    // differentiates the individual runs; `buildTag` is free-form
    // for filtering on the dashboard.
    customBuildName: args.customBuildName,
    buildIdentifier: args.buildIdentifier,
    maestroVersion: args.maestroVersion,
  };
  if (args.buildTag) body.buildTag = args.buildTag;
  if (args.project) body.project = args.project;
  const deviceSummary = args.devices.length === 1 ? args.devices[0] : `${args.devices.length} devices`;
  console.log(`  → trigger ${args.platform} build on ${deviceSummary} (flow=${args.flow})…`);
  const r = await bsFetch(`${API}/${args.platform}/build`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const buildId = (r.build_id ?? r.buildId ?? r.id) as string | undefined;
  if (!buildId) {
    throw new Error(`unexpected build trigger response: ${JSON.stringify(r)}`);
  }
  console.log(`    https://app-automate.browserstack.com/dashboard/v2/builds/${buildId}`);
  return buildId;
}

const TERMINAL_STATUSES = new Set([
  "passed", "failed", "error", "done", "stopped", "timeout", "skipped",
]);

/**
 * Polls build status until terminal. Returns the full build details
 * (with session/test IDs) so the caller can fetch device logs.
 */
async function waitForBuildTerminal(buildId: string, pollMs = 15_000): Promise<Record<string, unknown>> {
  let lastStatus = "";
  while (true) {
    const r = await bsFetch(`${API}/builds/${buildId}`);
    const status = String(r.status ?? "pending");
    if (status !== lastStatus) {
      console.log(`    [${new Date().toISOString().slice(11, 19)}] status=${status}`);
      lastStatus = status;
    }
    if (TERMINAL_STATUSES.has(status)) return r;
    await sleep(pollMs);
  }
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/**
 * Returns the per-test session+test IDs and device-log URL for every
 * device in a build. One row per device.
 */
type DeviceLogRef = {
  device: string;
  sessionId: string;
  testId: string;
  deviceLogUrl: string;
};

async function listBuildDeviceLogs(buildId: string, build: Record<string, unknown>): Promise<DeviceLogRef[]> {
  const refs: DeviceLogRef[] = [];
  const devices = (build.devices ?? []) as Array<Record<string, unknown>>;
  for (const dev of devices) {
    const sessions = (dev.sessions ?? []) as Array<Record<string, unknown>>;
    for (const session of sessions) {
      const sessionId = String(session.id ?? "");
      // Per-session detail surfaces test IDs + the pre-signed
      // device-log URL we want to GET.
      const detail = await bsFetch(`${API}/builds/${buildId}/sessions/${sessionId}`);
      const tcData = ((detail.testcases as Record<string, unknown>)?.data ?? []) as Array<Record<string, unknown>>;
      for (const tcGroup of tcData) {
        const tests = (tcGroup.testcases ?? []) as Array<Record<string, unknown>>;
        for (const tc of tests) {
          refs.push({
            device: String(dev.device ?? "unknown"),
            sessionId,
            testId: String(tc.id ?? ""),
            deviceLogUrl: String(tc.device_log ?? ""),
          });
        }
      }
    }
  }
  return refs;
}

const BENCH_SPAN_RE = /BENCH_SPAN (\{.*?\})\s*$/m;

/**
 * Pulls a device log and writes every parseable BENCH_SPAN line to
 * NDJSON. Returns the count of spans parsed for this device.
 */
async function pullAndParseDeviceLog(ref: DeviceLogRef, outDir: string): Promise<number> {
  if (!ref.deviceLogUrl) {
    console.warn(`    skip ${ref.device}: no device_log URL (deviceLogs may not have been enabled)`);
    return 0;
  }
  const res = await fetch(ref.deviceLogUrl, {
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) {
    console.warn(`    skip ${ref.device}: device_log fetch ${res.status}`);
    return 0;
  }
  const text = await res.text();
  // Logcat emits one log entry per line, but a span JSON could in
  // principle contain newlines if a future contributor breaks the
  // single-line invariant. Splitting on \n and matching per-line is
  // the safe pattern.
  const lines = text.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(/BENCH_SPAN (\{.+\})/);
    if (!m) continue;
    try {
      // Validate it's parseable JSON before committing it; a logcat
      // truncation would otherwise leave a half-span in the file.
      JSON.parse(m[1]!);
      out.push(m[1]!);
    } catch {
      // skip unparseable
    }
  }
  if (out.length === 0) return 0;
  const slug = `${slugify(ref.device)}-${ref.sessionId.slice(0, 8)}.ndjson`;
  const outPath = path.join(outDir, slug);
  await mkdir(outDir, { recursive: true });
  await writeFile(outPath, out.join("\n") + "\n");
  console.log(`    ${ref.device}: ${out.length} spans → ${path.relative(PROJECT_ROOT, outPath)}`);
  return out.length;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

/**
 * Runs the full build → wait → pull-logs cycle for one batch.
 */
async function dispatchBatch(args: BuildArgs): Promise<{ buildId: string; spanCount: number }> {
  const buildId = await triggerBuild(args);
  console.log(`  ⏳ waiting for build to reach terminal…`);
  const build = await waitForBuildTerminal(buildId);
  const status = String(build.status);
  console.log(`  ✓ build ${status} in ${build.duration}s`);
  // Even after the last session's `passed`, BS keeps the build
  // `running` while it flushes logs/videos to S3 — but by the time
  // overall status is terminal, device_log URLs are populated. Pull
  // them now.
  console.log(`  ↓ pulling device logs…`);
  const refs = await listBuildDeviceLogs(buildId, build);
  let total = 0;
  for (const ref of refs) {
    total += await pullAndParseDeviceLog(ref, RESULTS_DIR);
  }
  return { buildId, spanCount: total };
}

async function buildFlowsZip(): Promise<{ zipPath: string; cleanup: () => Promise<void> }> {
  const work = await mkdtemp(path.join(tmpdir(), "comapeo-bench-"));
  const flowsDir = path.join(work, "flows");
  await mkdir(flowsDir, { recursive: true });
  const entries = await readdir(FLOWS_SRC_DIR);
  const benchFlows = entries.filter((e) => e.startsWith("bench-") && e.endsWith(".yaml"));
  if (benchFlows.length === 0) {
    throw new Error(`no bench-*.yaml flows found under ${FLOWS_SRC_DIR}`);
  }
  for (const flow of benchFlows) {
    await copyFile(path.join(FLOWS_SRC_DIR, flow), path.join(flowsDir, flow));
  }
  const zipPath = path.join(work, "flows.zip");
  await runProcess("zip", ["-q", "-r", zipPath, "flows"], { cwd: work });
  return {
    zipPath,
    cleanup: () => rm(work, { recursive: true, force: true }),
  };
}

function runProcess(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${cmd} exited ${code}`));
    });
  });
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  const args = parseArgs();

  if (args.appAndroid && !(await fileExists(args.appAndroid))) {
    throw new Error(`--app-android path not found: ${args.appAndroid}`);
  }
  if (args.appIos && !(await fileExists(args.appIos))) {
    throw new Error(`--app-ios path not found: ${args.appIos}`);
  }
  if (!(await fileExists(path.join(FLOWS_SRC_DIR, args.flow)))) {
    throw new Error(`--flow not found in ${FLOWS_SRC_DIR}: ${args.flow}`);
  }

  console.log(`build name:       ${args.customBuildName}`);
  console.log(`build identifier: ${args.buildIdentifier}`);
  console.log(`maestro version:  ${args.maestroVersion}`);

  const capacity = await fetchPlanCapacity();
  console.log(`plan capacity:    ${capacity} devices per build (parallel + queued)`);

  console.log("staging Maestro test suite…");
  const { zipPath, cleanup } = await buildFlowsZip();

  let totalSpans = 0;
  const buildIds: Array<{ platform: Platform; buildId: string }> = [];

  try {
    const testSuiteUrl = await uploadTestSuite(zipPath, CUSTOM_ID.testSuite);

    for (const platform of ["android", "ios"] as const) {
      const appPath = platform === "android" ? args.appAndroid : args.appIos;
      const devices = platform === "android" ? args.devicesAndroid : args.devicesIos;
      if (!appPath || devices.length === 0) continue;

      const appUrl = await uploadApp(
        appPath,
        platform === "android" ? CUSTOM_ID.android : CUSTOM_ID.ios,
      );

      const batches = chunk(devices, capacity);
      console.log(
        `\n=== ${platform}: ${devices.length} device(s) → ${batches.length} batch(es) ===`,
      );

      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i]!;
        const batchSuffix = batches.length === 1 ? "" : `.${i + 1}`;
        console.log(`\nbatch ${i + 1}/${batches.length} (${batch.length} devices)`);
        const { buildId, spanCount } = await dispatchBatch({
          platform,
          appUrl,
          testSuiteUrl,
          devices: batch,
          flow: args.flow,
          customBuildName: args.customBuildName,
          buildIdentifier: `${args.buildIdentifier}${batchSuffix}`,
          buildTag: args.buildTag,
          project: args.project,
          maestroVersion: args.maestroVersion,
        });
        buildIds.push({ platform, buildId });
        totalSpans += spanCount;
      }
    }

    console.log("\n=== summary ===");
    for (const { platform, buildId } of buildIds) {
      console.log(`  ${platform}: https://app-automate.browserstack.com/dashboard/v2/builds/${buildId}`);
    }
    console.log(`  spans collected: ${totalSpans} → ${path.relative(PROJECT_ROOT, RESULTS_DIR)}/`);
    console.log(`\nrun \`npm run bench:summarize\` to refresh apps/benchmark/RESULTS.md`);
  } finally {
    await cleanup();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
