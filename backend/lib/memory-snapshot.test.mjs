import test from "node:test";
import assert from "node:assert/strict";

import {
  heapStatsFrom,
  memorySnapshot,
  parseProcStatus,
  processMemoryFrom,
  runtimeVersion,
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

test("processMemoryFrom maps a full status file", () => {
  assert.deepEqual(processMemoryFrom(PROC_STATUS), {
    rssBytes: 192_600 * 1024,
    peakRssBytes: 261_000 * 1024,
    anonBytes: 92_500 * 1024,
    fileBytes: 99_100 * 1024,
    swapBytes: 26_500 * 1024,
  });
});

test("processMemoryFrom returns null when the meaningful fields are missing", () => {
  assert.equal(processMemoryFrom("Name:\tnode\nThreads:\t3\n"), null);
});

test("processMemoryFrom tolerates a status file without the optional fields", () => {
  assert.deepEqual(processMemoryFrom("VmHWM:\t  100 kB\nVmRSS:\t   80 kB\n"), {
    rssBytes: 80 * 1024,
    peakRssBytes: 100 * 1024,
    anonBytes: 0,
    fileBytes: 0,
    swapBytes: 0,
  });
});

test("heapStatsFrom maps the V8 fields we report", () => {
  assert.deepEqual(heapStatsFrom(HEAP), {
    usedBytes: 16_598_748,
    physicalBytes: 27_484_160,
    totalBytes: 35_233_792,
    limitBytes: 569_114_624,
    externalBytes: 10_081_653,
  });
});

test("runtimeVersion reads the nodejs-mobile revision", () => {
  assert.equal(runtimeVersion({ mobile: "24.19.0-0" }), "24.19.0-0");
  assert.equal(runtimeVersion({}), "unknown");
});

// The real production path, end to end. `/proc/self/status` genuinely exists
// on Linux and genuinely doesn't on macOS/iOS, so between dev machines and CI
// both sides of the platform gate run for real.
test("memorySnapshot returns a well-formed snapshot of this process", () => {
  const snapshot = memorySnapshot();
  assert.equal(typeof snapshot.runtime, "string");
  assert.ok(snapshot.heap.usedBytes > 0);
  assert.ok(snapshot.heap.physicalBytes > 0);
  assert.ok(snapshot.heap.limitBytes > 0);
  if (process.platform === "linux") {
    assert.ok(snapshot.process !== null);
    assert.ok(snapshot.process.rssBytes > 0);
    assert.ok(snapshot.process.peakRssBytes >= snapshot.process.rssBytes);
  } else {
    assert.equal(snapshot.process, null);
  }
});
