// Process + V8 memory snapshot for the backend.
//
// Two sources that deliberately stay separate because they measure different
// things:
//
//   - V8 heap statistics describe the JavaScript heap only, and are
//     meaningful on both platforms.
//   - `/proc/self/status` describes the whole OS process. That is only "the
//     backend" on Android, where node runs in its own `:ComapeoCore` process.
//     On iOS node shares the app process, so the same numbers would describe
//     the UI too — which is why `metrics.backendMemorySample` has always
//     omitted `process.memoryUsage().rss`. iOS has no `/proc`, so the reader
//     returns `null` there and the caller emits nothing: the platform gate is
//     the filesystem, not a flag that could drift out of sync.
//
// `VmHWM` is the peak resident set since process start. It is the number that
// decides whether Android's low-memory killer picks this process (oom_score
// scales with footprint), and it is monotonic — so one late read still
// captures the boot peak, and no high-rate sampling is needed to find it.
//
// `total_physical_size` is the V8 heap memory actually committed and touched,
// as opposed to `used_heap_size` (live objects) or `total_heap_size`
// (reserved). It is the heap figure that tracks the process's anonymous RSS,
// so it is the one that moves when the runtime's memory layout changes.

import fs from "node:fs";
import v8 from "node:v8";

const PROC_SELF_STATUS = "/proc/self/status";

/**
 * @typedef {{
 *   rssBytes: number,
 *   peakRssBytes: number,
 *   anonBytes: number,
 *   fileBytes: number,
 *   swapBytes: number,
 * }} ProcessMemory
 *
 * @typedef {{
 *   usedBytes: number,
 *   physicalBytes: number,
 *   totalBytes: number,
 *   limitBytes: number,
 *   externalBytes: number,
 * }} HeapStats
 *
 * @typedef {{
 *   runtime: string,
 *   heap: HeapStats,
 *   process: ProcessMemory | null,
 * }} MemorySnapshot
 */

/** `/proc` fields we care about, all reported in kB. */
const PROC_FIELDS = {
  VmRSS: "rssBytes",
  VmHWM: "peakRssBytes",
  RssAnon: "anonBytes",
  RssFile: "fileBytes",
  VmSwap: "swapBytes",
};

/**
 * Parses the `Key: <n> kB` lines of `/proc/<pid>/status` into bytes.
 * Split out from the read so it can be tested against fixture text.
 *
 * @param {string} text Contents of a `/proc/<pid>/status` file.
 * @returns {Record<string, number>} Bytes, keyed by the names in `PROC_FIELDS`.
 */
export function parseProcStatus(text) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const line of text.split("\n")) {
    const match = /^(\w+):\s+(\d+)\s*kB$/.exec(line);
    if (!match) continue;
    const key = PROC_FIELDS[/** @type {keyof typeof PROC_FIELDS} */ (match[1])];
    if (key) out[key] = Number(match[2]) * 1024;
  }
  return out;
}

/**
 * Whole-process memory, or `null` where `/proc` is unavailable (iOS) or
 * unreadable. Best-effort by design: this is telemetry, never a boot
 * dependency.
 *
 * @param {{ readFileSync?: (path: string, encoding: string) => string }} [deps] test seam
 * @returns {ProcessMemory | null}
 */
export function readProcessMemory(deps = {}) {
  const readFileSync = deps.readFileSync ?? fs.readFileSync;
  let text;
  try {
    text = readFileSync(PROC_SELF_STATUS, "utf8");
  } catch {
    return null;
  }
  const parsed = parseProcStatus(text);
  // VmRSS and VmHWM are the two that carry the meaning; without them the
  // sample is not worth emitting.
  if (parsed.rssBytes === undefined || parsed.peakRssBytes === undefined) {
    return null;
  }
  return {
    rssBytes: parsed.rssBytes,
    peakRssBytes: parsed.peakRssBytes,
    anonBytes: parsed.anonBytes ?? 0,
    fileBytes: parsed.fileBytes ?? 0,
    swapBytes: parsed.swapBytes ?? 0,
  };
}

/**
 * V8 heap statistics, in bytes.
 *
 * @param {{ getHeapStatistics?: () => v8.HeapInfo }} [deps] test seam
 */
export function readHeapStats(deps = {}) {
  const getHeapStatistics = deps.getHeapStatistics ?? v8.getHeapStatistics;
  const heap = getHeapStatistics();
  return {
    usedBytes: heap.used_heap_size,
    physicalBytes: heap.total_physical_size,
    totalBytes: heap.total_heap_size,
    limitBytes: heap.heap_size_limit,
    externalBytes: heap.external_memory ?? 0,
  };
}

/**
 * One combined snapshot. `runtime` is the nodejs-mobile revision
 * (`process.versions.mobile`, e.g. `24.19.0-0`) — the dimension you slice by
 * when comparing one runtime build against another, and the reason a fleet
 * gauge can answer "did the new libnode help" without a bespoke experiment.
 *
 * @param {{
 *   readFileSync?: (path: string, encoding: string) => string,
 *   getHeapStatistics?: () => v8.HeapInfo,
 *   versions?: Record<string, string | undefined>,
 * }} [deps] test seam
 */
export function memorySnapshot(deps = {}) {
  const versions = deps.versions ?? process.versions;
  return {
    runtime: versions.mobile ?? "unknown",
    heap: readHeapStats(deps),
    process: readProcessMemory(deps),
  };
}
