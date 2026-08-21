import test from "node:test";
import assert from "node:assert/strict";

import {
  memorySnapshot,
  parseProcStatus,
  readHeapStats,
  readProcessMemory,
} from "./memory-snapshot.js";

const PROC_STATUS = `Name:\tnode
Umask:\t0077
State:\tS (sleeping)
Tgid:\t14704
VmPeak:\t26003584 kB
VmSize:\t25937544 kB
VmLck:\t       0 kB
VmHWM:\t  261000 kB
VmRSS:\t  192600 kB
RssAnon:\t   92500 kB
RssFile:\t   99100 kB
RssShmem:\t     580 kB
VmSwap:\t   26500 kB
Threads:\t14
`;

/** @type {import("node:v8").HeapInfo} */
const HEAP = {
  total_heap_size: 35_233_792,
  total_heap_size_executable: 2_838_528,
  total_physical_size: 27_484_160,
  total_available_size: 551_480_616,
  used_heap_size: 16_598_748,
  heap_size_limit: 569_114_624,
  malloced_memory: 548_908,
  peak_malloced_memory: 28_204_576,
  does_zap_garbage: 0,
  number_of_native_contexts: 1,
  number_of_detached_contexts: 0,
  total_global_handles_size: 8_192,
  used_global_handles_size: 4_096,
  external_memory: 10_081_653,
};

test("parseProcStatus converts the kB fields we care about to bytes", () => {
  const parsed = parseProcStatus(PROC_STATUS);
  assert.equal(parsed.peakRssBytes, 261_000 * 1024);
  assert.equal(parsed.rssBytes, 192_600 * 1024);
  assert.equal(parsed.anonBytes, 92_500 * 1024);
  assert.equal(parsed.fileBytes, 99_100 * 1024);
  assert.equal(parsed.swapBytes, 26_500 * 1024);
});

test("parseProcStatus ignores fields outside the allowlist", () => {
  const parsed = parseProcStatus(PROC_STATUS);
  assert.equal(parsed.VmPeak, undefined);
  assert.equal(parsed.VmSize, undefined);
  assert.equal(Object.keys(parsed).length, 5);
});

test("readProcessMemory returns bytes from /proc/self/status", () => {
  const mem = readProcessMemory({ readFileSync: () => PROC_STATUS });
  assert.deepEqual(mem, {
    rssBytes: 192_600 * 1024,
    peakRssBytes: 261_000 * 1024,
    anonBytes: 92_500 * 1024,
    fileBytes: 99_100 * 1024,
    swapBytes: 26_500 * 1024,
  });
});

test("readProcessMemory returns null where /proc is unavailable (iOS)", () => {
  const mem = readProcessMemory({
    readFileSync: () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  });
  assert.equal(mem, null);
});

test("readProcessMemory returns null when the meaningful fields are missing", () => {
  const mem = readProcessMemory({ readFileSync: () => "Name:\tnode\nThreads:\t3\n" });
  assert.equal(mem, null);
});

test("readProcessMemory tolerates a status file without the optional fields", () => {
  const mem = readProcessMemory({
    readFileSync: () => "VmHWM:\t  100 kB\nVmRSS:\t   80 kB\n",
  });
  assert.deepEqual(mem, {
    rssBytes: 80 * 1024,
    peakRssBytes: 100 * 1024,
    anonBytes: 0,
    fileBytes: 0,
    swapBytes: 0,
  });
});

test("readHeapStats maps the V8 fields we report", () => {
  const heap = readHeapStats({ getHeapStatistics: () => HEAP });
  assert.deepEqual(heap, {
    usedBytes: 16_598_748,
    physicalBytes: 27_484_160,
    totalBytes: 35_233_792,
    limitBytes: 569_114_624,
    externalBytes: 10_081_653,
  });
});

test("memorySnapshot carries the nodejs-mobile revision as `runtime`", () => {
  const snapshot = memorySnapshot({
    readFileSync: () => PROC_STATUS,
    getHeapStatistics: () => HEAP,
    versions: { mobile: "24.19.0-0" },
  });
  assert.equal(snapshot.runtime, "24.19.0-0");
  assert.equal(snapshot.heap.physicalBytes, 27_484_160);
  assert.equal(snapshot.process?.peakRssBytes, 261_000 * 1024);
});

test("memorySnapshot falls back to `unknown` off nodejs-mobile", () => {
  const snapshot = memorySnapshot({
    readFileSync: () => {
      throw new Error("no /proc");
    },
    getHeapStatistics: () => HEAP,
    versions: {},
  });
  assert.equal(snapshot.runtime, "unknown");
  assert.equal(snapshot.process, null);
});
