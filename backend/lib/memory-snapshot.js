// V8 heap statistics plus, where `/proc` exists (Android only), whole-process
// memory. What each number means and why it is the one reported:
// docs/BENCHMARKING.md.

import fs from "node:fs";
import v8 from "node:v8";

const PROC_SELF_STATUS = "/proc/self/status";

/**
 * nodejs-mobile revision (`process.versions.mobile`, e.g. `24.19.0-0`). Shared
 * so the Sentry `nodejs_mobile` event tag and the `runtime` metric attribute
 * always join on the same value.
 *
 * @param {Record<string, string | undefined>} [versions]
 */
export function runtimeVersion(versions = process.versions) {
  return versions.mobile ?? "unknown";
}

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
 * Whole-process memory from `/proc/<pid>/status` text, or `null` when the
 * meaningful fields are absent.
 *
 * @param {string} text Contents of a `/proc/<pid>/status` file.
 * @returns {ProcessMemory | null}
 */
export function processMemoryFrom(text) {
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
 * The V8 heap fields we report, in bytes.
 *
 * @param {v8.HeapInfo} heap
 * @returns {HeapStats}
 */
export function heapStatsFrom(heap) {
  return {
    usedBytes: heap.used_heap_size,
    physicalBytes: heap.total_physical_size,
    totalBytes: heap.total_heap_size,
    limitBytes: heap.heap_size_limit,
    externalBytes: heap.external_memory ?? 0,
  };
}

/**
 * One combined snapshot, `runtime` included so the log line names the
 * nodejs-mobile build it measured. `process` is `null` where `/proc` is
 * unavailable (iOS) or unreadable — best-effort by design: this is telemetry,
 * never a boot dependency.
 *
 * @returns {MemorySnapshot}
 */
export function memorySnapshot() {
  let process_ = null;
  try {
    process_ = processMemoryFrom(fs.readFileSync(PROC_SELF_STATUS, "utf8"));
  } catch {
    // No `/proc` here.
  }
  return {
    runtime: runtimeVersion(),
    heap: heapStatsFrom(v8.getHeapStatistics()),
    process: process_,
  };
}
