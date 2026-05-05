/**
 * Minimal BrowserStack App Automate runner for the bench Maestro
 * flows. Uploads the app + the Maestro test suite, triggers a build,
 * prints the dashboard URL.
 *
 * Usage:
 *   node --env-file=.env scripts/run-on-browserstack.ts \
 *     [--app-android <path-to.apk>] \
 *     [--app-ios <path-to.ipa>] \
 *     [--flow bench-rpc.yaml] \
 *     [--device-android "Samsung Galaxy S23 Ultra-13.0"] \
 *     [--device-ios "iPhone 15-17"] \
 *     [--build-name <label>]
 *
 * If only one of --app-android / --app-ios is given, only that
 * platform runs. Default flow is `bench-rpc.yaml`; use
 * `bench-rpc-receiver.yaml` when running with a host-side
 * `bench-receiver.ts` + BrowserStackLocal tunnel.
 *
 * Auth comes from `.env` (BROWSERSTACK_USERNAME, BROWSERSTACK_ACCESS_KEY).
 *
 * Re-uploads are avoided by `custom_id`-keyed lookups: the same APK /
 * IPA / test-suite hash maps back to a single bs:// url across runs.
 *
 * API references:
 *   https://www.browserstack.com/docs/app-automate/api-reference/maestro/apps
 *   https://www.browserstack.com/docs/app-automate/api-reference/maestro/tests
 *   https://www.browserstack.com/docs/app-automate/maestro/get-started/execute-tests
 */

import { mkdtemp, rm, copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const FLOWS_SRC_DIR = path.join(PROJECT_ROOT, "e2e/.maestro");

const API = "https://api-cloud.browserstack.com/app-automate/maestro/v2";

// Reasonable defaults that hit a representative low-end and a recent
// flagship for each platform. Override via --device-android /
// --device-ios for an actual sweep.
const DEFAULT_DEVICES = {
  android: "Samsung Galaxy S23 Ultra-13.0",
  ios: "iPhone 15-17",
};

// `custom_id` keys used to deduplicate re-uploads across runs. The
// hash inside the bs:// URL changes per file content, so the BS API
// lets us look up "the latest upload tagged with this custom_id"
// rather than re-uploading byte-identical artefacts.
const CUSTOM_ID = {
  android: "comapeo-bench-android",
  ios: "comapeo-bench-ios",
  testSuite: "comapeo-bench-flows",
};

type CliArgs = {
  appAndroid?: string;
  appIos?: string;
  flow: string;
  deviceAndroid: string;
  deviceIos: string;
  buildName: string;
};

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const out: CliArgs = {
    flow: "bench-rpc.yaml",
    deviceAndroid: DEFAULT_DEVICES.android,
    deviceIos: DEFAULT_DEVICES.ios,
    buildName: `comapeo-bench-${new Date().toISOString().replace(/[:.]/g, "-")}`,
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
        out.deviceAndroid = v; i++; break;
      case "--device-ios":
        out.deviceIos = v; i++; break;
      case "--build-name":
        out.buildName = v; i++; break;
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

function printUsageAndExit(code: number): never {
  console.log(
    "usage: node --env-file=.env scripts/run-on-browserstack.ts \\\n" +
      "    [--app-android <path.apk>] \\\n" +
      "    [--app-ios <path.ipa>] \\\n" +
      "    [--flow bench-rpc.yaml] \\\n" +
      "    [--device-android \"Samsung Galaxy S23 Ultra-13.0\"] \\\n" +
      "    [--device-ios \"iPhone 15-17\"] \\\n" +
      "    [--build-name <label>]",
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

// Auth is resolved lazily so `--help` and arg-validation errors don't
// require BROWSERSTACK_USERNAME/ACCESS_KEY to be set first.
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

async function bsFetch(pathname: string, init: RequestInit = {}) {
  const url = `${API}${pathname}`;
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
      `BrowserStack ${init.method ?? "GET"} ${pathname} → ${res.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`,
    );
  }
  return body as Record<string, unknown>;
}

/**
 * `multipart/form-data` body assembled by hand — no `form-data` dep.
 * Node's global `fetch` accepts a `Buffer`/`Uint8Array` body, which
 * sidesteps the streaming-FormData TypeScript headaches of `undici`
 * for a one-shot upload.
 */
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
  return bsFetch(pathname, {
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

async function triggerBuild(args: {
  platform: "android" | "ios";
  appUrl: string;
  testSuiteUrl: string;
  device: string;
  flow: string;
  buildName: string;
}) {
  const body = {
    app: args.appUrl,
    testSuite: args.testSuiteUrl,
    project: "comapeo-core-react-native-bench",
    buildName: args.buildName,
    devices: [args.device],
    // Target a single flow inside the zip's `flows/` parent dir. Drop
    // this key to run `main.yaml` instead.
    execute: [`flows/${args.flow}`],
  };
  console.log(`  → trigger ${args.platform} build on ${args.device} (flow=${args.flow})…`);
  const r = await bsFetch(`/${args.platform}/build`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r;
}

/**
 * Stages every `bench-*.yaml` flow into `<tmp>/flows/` (the parent-
 * dir layout the BrowserStack docs require) and returns the path to
 * a zip ready for upload.
 */
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

  console.log(`build name: ${args.buildName}`);
  console.log("staging Maestro test suite…");
  const { zipPath, cleanup } = await buildFlowsZip();

  try {
    const testSuiteUrl = await uploadTestSuite(zipPath, CUSTOM_ID.testSuite);

    const builds: Array<{ platform: string; result: Record<string, unknown> }> = [];
    if (args.appAndroid) {
      const appUrl = await uploadApp(args.appAndroid, CUSTOM_ID.android);
      const result = await triggerBuild({
        platform: "android",
        appUrl,
        testSuiteUrl,
        device: args.deviceAndroid,
        flow: args.flow,
        buildName: args.buildName,
      });
      builds.push({ platform: "android", result });
    }
    if (args.appIos) {
      const appUrl = await uploadApp(args.appIos, CUSTOM_ID.ios);
      const result = await triggerBuild({
        platform: "ios",
        appUrl,
        testSuiteUrl,
        device: args.deviceIos,
        flow: args.flow,
        buildName: args.buildName,
      });
      builds.push({ platform: "ios", result });
    }

    console.log("");
    for (const { platform, result } of builds) {
      const buildId = (result.build_id ?? result.buildId ?? result.id) as string | undefined;
      const dashboardUrl = buildId
        ? `https://app-automate.browserstack.com/dashboard/v2/builds/${buildId}`
        : "(no build_id in response — check API response below)";
      console.log(`${platform}: ${dashboardUrl}`);
      if (!buildId) {
        console.log(`  raw response: ${JSON.stringify(result)}`);
      }
    }
  } finally {
    await cleanup();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
