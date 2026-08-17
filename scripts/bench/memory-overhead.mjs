// Measures the cost of the memory-introspection APIs that
// `docs/memory-monitoring-plan.md` proposes sampling in the backend, so the
// overhead numbers in that plan's §7 are reproducible rather than asserted.
//
//   node scripts/bench/memory-overhead.mjs
//
// Two things are measured:
//
//   1. Per-call cost of each sampling API (§7.1). These run at 1 Hz in the
//      proposed design, so anything in the microsecond range is free.
//   2. The marginal cost of a `PerformanceObserver` on `gc` entries (§7.2),
//      which is the only piece with a per-event (rather than per-second) cost.
//      Measured as interleaved A/B/C trials over an allocation-heavy workload,
//      plus direct instrumentation of the callback itself — the interleaved
//      wall-clock delta is close to the noise floor, so the per-event figure is
//      the one that scales to a real GC rate.
//
// The plan's numbers were taken on x64 / Node 22 / JIT. The device runs
// arm64 / Node 18.20.4 / nodejs-mobile, and iOS runs V8 jitless, where
// interpreted JS glue is several times slower (the syscall portion of
// `process.memoryUsage()` is not). Re-run this through the `apps/integration`
// app before relying on §7.2 on device.

import v8 from "node:v8";
import os from "node:os";
import { performance, PerformanceObserver } from "node:perf_hooks";

const median = (xs) =>
  xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const mb = (bytes) => `${(bytes / 2 ** 20).toFixed(0)} MB`;

// ── 1. Per-call cost ────────────────────────────────────────────

function bench(name, fn, iterations = 20_000) {
  for (let i = 0; i < 2_000; i++) fn(); // warm
  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const usPerCall = ((performance.now() - start) * 1000) / iterations;
  console.log(`  ${name.padEnd(32)} ${usPerCall.toFixed(2)} µs/call`);
}

console.log(`node ${process.version} ${process.arch} ${process.platform}`);
console.log("\n── per-call cost ──");
bench("v8.getHeapStatistics()", () => v8.getHeapStatistics());
bench("v8.getHeapSpaceStatistics()", () => v8.getHeapSpaceStatistics());
bench("process.memoryUsage()", () => process.memoryUsage());
bench("process.memoryUsage.rss()", () => process.memoryUsage.rss());
bench("os.freemem()", () => os.freemem());
bench("process.constrainedMemory()", () => process.constrainedMemory?.());
bench("process.uptime()", () => process.uptime());

// Which fields actually exist here — Node 18 (nodejs-mobile) is missing some
// of what Node 22 reports, so the plan designs against the intersection.
const heap = v8.getHeapStatistics();
console.log("\n── v8.getHeapStatistics() fields ──");
console.log(`  ${Object.keys(heap).join(", ")}`);
console.log(
  `\n  heap_size_limit ${mb(heap.heap_size_limit)} | os.totalmem ${mb(os.totalmem())}` +
    ` | constrainedMemory ${mb(process.constrainedMemory?.() ?? 0)}`,
);

// ── 2. GC observer overhead ─────────────────────────────────────

// Allocation churn that yields to the event loop between chunks: a fully
// synchronous loop queues PerformanceObserver callbacks without ever draining
// them, which measures the native side only and reads as "free".
const retained = [];
function churn() {
  for (let round = 0; round < 40; round++) {
    const arr = new Array(1000);
    for (let i = 0; i < 1000; i++) arr[i] = { i, s: "x".repeat(16) };
    if (round % 10 === 0) retained.push(arr); // force some promotion
    if (retained.length > 40) retained.shift();
  }
}

async function run(chunks) {
  const start = performance.now();
  for (let c = 0; c < chunks; c++) {
    churn();
    await new Promise((resolve) => setImmediate(resolve));
  }
  return performance.now() - start;
}

let callbackMs = 0;
let gcEvents = 0;
const makeObserver = (sampleMemory) =>
  new PerformanceObserver((list) => {
    const start = performance.now();
    for (const _entry of list.getEntries()) {
      gcEvents++;
      // The realistic callback body if we wanted per-GC heap readings.
      if (sampleMemory) void process.memoryUsage().heapUsed;
    }
    callbackMs += performance.now() - start;
  });

const CHUNKS = 200;
const REPS = 10;

await run(50); // warm

const noObserver = [];
const withObserver = [];
const withObserverAndMemory = [];
for (let i = 0; i < REPS; i++) {
  noObserver.push(await run(CHUNKS));

  const plain = makeObserver(false);
  plain.observe({ entryTypes: ["gc"] });
  withObserver.push(await run(CHUNKS));
  plain.disconnect();

  const sampling = makeObserver(true);
  sampling.observe({ entryTypes: ["gc"] });
  withObserverAndMemory.push(await run(CHUNKS));
  sampling.disconnect();
}

const base = median(noObserver);
const obs = median(withObserver);
const obsMem = median(withObserverAndMemory);
const pct = (x) => `${(((x - base) / base) * 100).toFixed(2)}%`;

console.log(`\n── gc PerformanceObserver overhead (interleaved x${REPS}) ──`);
console.log(`  no observer                ${base.toFixed(1)} ms`);
console.log(`  gc observer                ${obs.toFixed(1)} ms  (${pct(obs)})`);
console.log(
  `  gc observer + memoryUsage  ${obsMem.toFixed(1)} ms  (${pct(obsMem)})`,
);

if (gcEvents === 0) {
  // The signal that matters on nodejs-mobile: a stripped V8 may not deliver
  // gc entries at all, in which case the plan's phase 4 is dropped.
  console.log(
    "\n  !! no gc entries observed — perf_hooks GC monitoring is unavailable here",
  );
} else {
  const perEventUs = (callbackMs * 1000) / gcEvents;
  const gcPerSecond = gcEvents / REPS / 2 / ((obs + obsMem) / 2 / 1000);
  console.log(
    `\n  ${perEventUs.toFixed(1)} µs per gc event in the callback ` +
      `(${gcEvents} events, ${gcPerSecond.toFixed(0)} gc/s in this synthetic load)`,
  );
  console.log("  → extrapolated overhead at a realistic gc rate:");
  for (const rate of [1, 5, 20, 50]) {
    const fraction = (perEventUs * rate) / 1e6;
    console.log(
      `      ${String(rate).padStart(3)} gc/s  ${(perEventUs * rate).toFixed(0)} µs/s  ` +
        `(${(fraction * 100).toFixed(3)}%)`,
    );
  }
}
