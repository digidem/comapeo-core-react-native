#!/usr/bin/env node
// Remaps a Node-backend stack trace to original source positions.
//
// Reads the stack from a file argument or stdin, rewrites every
// `<chunk>.mjs:<line>:<col>` position it can resolve, and leaves the rest
// untouched:
//
//   adb logcat -d | comapeo-rn-symbolicate
//   comapeo-rn-symbolicate crash.txt
//
// Maps come from the sourcemap dirs shipped in this package — the same
// files `comapeo-rn-upload-sourcemaps` pushes to Sentry.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { SourceMap } from "node:module";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// `build/cli/symbolicate.js` → up three to package root.
const PKG_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const SOURCEMAP_DIRS = {
  android: join(PKG_ROOT, "android/src/main/nodejs-sourcemaps"),
  ios: join(PKG_ROOT, "ios/nodejs-sourcemaps"),
} as const;

type Platform = keyof typeof SOURCEMAP_DIRS;

const USAGE = `\
Usage: comapeo-rn-symbolicate [options] [file]

Remaps a @comapeo/core-react-native backend stack trace to original source
positions using the sourcemaps shipped in this package. Reads stdin when no
file is given.

Options:
  --platform <android|ios>  Which platform's maps to use. Auto-detected from
                            paths in the input; defaults to android.
  -h, --help                Show this help.
`;

function fail(msg: string): never {
  process.stderr.write(`comapeo-rn-symbolicate: ${msg}\n`);
  process.exit(1);
}

const { values, positionals } = parseArgs({
  options: {
    platform: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
});

if (values.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

if (positionals.length > 1) {
  fail(`expected at most one file argument, got ${positionals.length}`);
}

const inputPath = positionals[0];
if (inputPath && !existsSync(inputPath)) {
  fail(`no such file: ${inputPath}`);
}
// fd 0 reads stdin; fine for piped input, which is the whole point here.
const input = readFileSync(inputPath ?? 0, "utf8");

/**
 * Android and iOS both emit `index.mjs`, so the basename alone cannot pick
 * a map. Sniff the sandbox path that appears in real backend stacks before
 * falling back to android.
 */
function detectPlatform(text: string): Platform {
  if (/\/(?:data\/user\/\d+|data\/data)\//.test(text)) return "android";
  if (/\/(?:var\/mobile|private\/var)\//.test(text)) return "ios";
  return "android";
}

const platform = (values.platform ?? detectPlatform(input)) as Platform;
if (!(platform in SOURCEMAP_DIRS)) {
  fail(
    `unknown --platform ${values.platform}. Valid: ${Object.keys(SOURCEMAP_DIRS).join(", ")}`,
  );
}

const sourcemapDir = SOURCEMAP_DIRS[platform];
if (!existsSync(sourcemapDir)) {
  fail(`sourcemap dir missing (${sourcemapDir})`);
}

// `<bundle file name>` → absolute path of its `.map`. Chunk maps live in a
// `chunks/` subdir, so walk recursively and key on the basename.
const mapPaths = new Map<string, string>();
for (const rel of readdirSync(sourcemapDir, { recursive: true })) {
  const relPath = String(rel);
  if (!relPath.endsWith(".map")) continue;
  const bundleName = relPath.slice(0, -".map".length).split(sep).pop();
  if (bundleName) mapPaths.set(bundleName, join(sourcemapDir, relPath));
}

const sourceMaps = new Map<string, SourceMap | null>();
function loadSourceMap(bundleName: string): SourceMap | null {
  const cached = sourceMaps.get(bundleName);
  if (cached !== undefined) return cached;
  const mapPath = mapPaths.get(bundleName);
  let sourceMap: SourceMap | null = null;
  if (mapPath) {
    try {
      sourceMap = new SourceMap(JSON.parse(readFileSync(mapPath, "utf8")));
    } catch {
      // Unreadable or malformed map — leave those frames unmapped rather
      // than aborting a whole log's worth of otherwise-usable output.
      sourceMap = null;
    }
  }
  sourceMaps.set(bundleName, sourceMap);
  return sourceMap;
}

interface MappedEntry {
  originalSource: string;
  originalLine: number;
  originalColumn: number;
  originalName?: string;
}

// `findEntry` is typed `{} | SourceMapping` — it returns a bare `{}` for a
// generated position with no mapping.
function isMapped(entry: object): entry is MappedEntry {
  return "originalSource" in entry;
}

// The leading directory is consumed as well as the file name, so the
// on-device path is replaced rather than left prefixed to the original one.
const FRAME_RE = /(?:[^\s()[\]]*[/\\])?([A-Za-z0-9_.-]+\.mjs):(\d+):(\d+)/g;

// Maps are written relative to the bundle, so sources start with a run of
// `../`. Strip it — what's left is the repo-relative path.
function tidySource(source: string): string {
  return source.replace(/^(?:\.\.[/\\])+/, "");
}

let resolved = 0;
let unresolved = 0;

const output = input.replace(
  FRAME_RE,
  (match, bundleName: string, lineStr: string, colStr: string) => {
    const sourceMap = loadSourceMap(bundleName);
    if (!sourceMap) {
      unresolved++;
      return match;
    }
    // Stack positions are 1-based; `findEntry` takes 0-based offsets.
    const entry = sourceMap.findEntry(Number(lineStr) - 1, Number(colStr) - 1);
    if (!entry || !isMapped(entry)) {
      unresolved++;
      return match;
    }
    resolved++;
    const name = entry.originalName ? ` (${entry.originalName})` : "";
    return `${tidySource(entry.originalSource)}:${entry.originalLine + 1}:${
      entry.originalColumn + 1
    }${name} [${bundleName}:${lineStr}:${colStr}]`;
  },
);

process.stdout.write(output);

if (resolved === 0 && unresolved === 0) {
  process.stderr.write(
    "comapeo-rn-symbolicate: no `<file>.mjs:<line>:<col>` positions found in input\n",
  );
} else {
  process.stderr.write(
    `comapeo-rn-symbolicate: ${platform} — ${resolved} frame(s) mapped, ${unresolved} unmapped\n`,
  );
}
