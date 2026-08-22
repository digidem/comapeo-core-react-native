// Pure parsing + statistics core for scripts/benchmark-boot.sh.
//
// No network, no filesystem, no process state: it takes captured text and
// returns plain objects, so it is unit-testable from fixtures
// (scripts/lib/benchmark-core.test.mjs). The I/O shell lives in
// scripts/benchmark-boot.sh (device orchestration) and
// scripts/benchmark-report.mjs (reading results, printing tables).
//
// The two contracts it parses are stable logging surfaces of the Android
// module, and breaking either should break these tests:
//
//   - `logCrumb` renders "[<category>] <message> {<attrs>}"
//     (android/src/main/java/com/comapeo/core/log.kt), which is how the
//     control-frame and lifecycle milestones appear.
//   - the backend prints one "[comapeo.memory] boot {json}" line a few
//     seconds after `ready` (backend/index.js). That line carries `VmHWM`
//     read from inside the process, which is why a boot benchmark does not
//     need root to get the peak RSS that matters.

// ── Boot milestones ─────────────────────────────────────────────

/**
 * Milestones in boot order. `pattern` matches the message part of a logcat
 * line; the first occurrence wins, because a retry after a failed boot
 * should not silently redefine t0.
 */
export const BOOT_MILESTONES = [
  { key: "fgsCreate", pattern: /\[comapeo\.fgs\] ComapeoCoreService\.onCreate/ },
  { key: "foreground", pattern: /Starting the foreground service/ },
  { key: "nodeStart", pattern: /\[comapeo\.boot\] start\(\)/ },
  { key: "started", pattern: /\[comapeo\.control\] received: started/ },
  { key: "ready", pattern: /\[comapeo\.control\] received: ready/ },
  { key: "stateStarted", pattern: /STARTING → STARTED/ },
];

/** `logcat -v epoch` prefixes each line with "  <sec>.<ms> <pid> <tid> <level> <tag>: ". */
const EPOCH_LINE = /^\s*(\d+\.\d+)\s+\d+\s+\d+\s+[VDIWEF]\s+[^:]+:\s?(.*)$/;

const MEMORY_LINE = /\[comapeo\.memory\] boot (\{.*\})\s*$/;

/**
 * Extracts boot milestone timestamps and the backend's boot memory snapshot
 * from an epoch-formatted logcat capture.
 *
 * @param {string} text Output of `logcat -v epoch`.
 * @returns {{
 *   milestones: Record<string, number>,
 *   memory: object | null,
 *   memoryEpoch: number | null,
 * }}
 */
export function parseLogcat(text) {
  /** @type {Record<string, number>} */
  const milestones = {};
  let memory = null;
  let memoryEpoch = null;

  for (const line of text.split("\n")) {
    const match = EPOCH_LINE.exec(line);
    if (!match) continue;
    const epoch = Number(match[1]);
    const message = match[2];

    for (const { key, pattern } of BOOT_MILESTONES) {
      if (milestones[key] === undefined && pattern.test(message)) {
        milestones[key] = epoch;
      }
    }

    const mem = MEMORY_LINE.exec(message);
    if (mem && !memory) {
      try {
        memory = JSON.parse(mem[1]);
        memoryEpoch = epoch;
      } catch {
        // A truncated line loses the snapshot, never the run.
      }
    }
  }

  return { milestones, memory, memoryEpoch };
}

/**
 * Seconds from launch to each milestone. `t0` is the host-side timestamp
 * taken immediately before `am start`, so `fgsCreate` includes process
 * creation — which is part of what a boot costs.
 *
 * @param {Record<string, number>} milestones
 * @param {number} t0 Epoch seconds at `am start`.
 */
export function bootDurations(milestones, t0) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const { key } of BOOT_MILESTONES) {
    if (milestones[key] !== undefined) out[key] = milestones[key] - t0;
  }
  return out;
}

// ── Device memory readouts ──────────────────────────────────────

/**
 * Total PSS in bytes from `dumpsys meminfo <pid>`. The TOTAL row's first
 * numeric column is Pss Total, in kB.
 *
 * @param {string} text
 * @returns {number | null}
 */
export function parseMeminfoPss(text) {
  const match = /^\s*TOTAL(?:\s+PSS)?:?\s+(\d+)/m.exec(text);
  return match ? Number(match[1]) * 1024 : null;
}

/**
 * Parses the timeline file written by scripts/lib/benchmark-sample.sh: one
 * whitespace-separated row per sample, `uptime rss hwm anon swap`, all the
 * memory columns in kB. Only produced when /proc of another process is
 * readable (a rooted emulator); the run is complete without it.
 *
 * @param {string} text
 * @returns {Array<{ t: number, rssBytes: number, peakRssBytes: number, anonBytes: number, swapBytes: number }>}
 */
export function parseProcTimeline(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const nums = parts.map(Number);
    if (nums.some(Number.isNaN)) continue;
    rows.push({
      t: nums[0],
      rssBytes: nums[1] * 1024,
      peakRssBytes: nums[2] * 1024,
      anonBytes: nums[3] * 1024,
      swapBytes: nums[4] * 1024,
    });
  }
  return rows;
}

// ── Statistics ──────────────────────────────────────────────────

/** @param {number[]} values */
export function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Sample standard deviation. @param {number[]} values */
export function stdev(values) {
  const sample = values.filter(Number.isFinite);
  if (sample.length < 2) return null;
  const mean = sample.reduce((a, b) => a + b, 0) / sample.length;
  const variance =
    sample.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (sample.length - 1);
  return Math.sqrt(variance);
}

/** Abramowitz & Stegun 7.1.26 normal CDF. @param {number} x */
function normalCdf(x) {
  const t = 1 / (1 + 0.2316419 * x);
  const density = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const poly =
    t *
    (0.319381530 +
      t *
        (-0.356563782 +
          t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return 1 - density * poly;
}

/**
 * Two-sided Mann–Whitney U with tie correction, normal approximation.
 *
 * Rank-based on purpose: boot measurements are skewed by the occasional
 * scheduling stall, so a t-test on a dozen boots would be driven by the
 * outlier. Returns null when either sample is empty or degenerate.
 *
 * @param {number[]} a
 * @param {number[]} b
 * @returns {{ u: number, z: number, p: number } | null}
 */
export function mannWhitneyU(a, b) {
  const x = a.filter(Number.isFinite);
  const y = b.filter(Number.isFinite);
  if (!x.length || !y.length) return null;

  const all = [
    ...x.map((v) => ({ v, group: 0 })),
    ...y.map((v) => ({ v, group: 1 })),
  ].sort((p, q) => p.v - q.v);

  const ranks = new Array(all.length);
  const tieGroups = [];
  let i = 0;
  while (i < all.length) {
    let j = i;
    while (j + 1 < all.length && all[j + 1].v === all[i].v) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = rank;
    tieGroups.push(j - i + 1);
    i = j + 1;
  }

  let rankSumX = 0;
  all.forEach((item, index) => {
    if (item.group === 0) rankSumX += ranks[index];
  });

  const n1 = x.length;
  const n2 = y.length;
  const u = rankSumX - (n1 * (n1 + 1)) / 2;
  const mu = (n1 * n2) / 2;
  const n = n1 + n2;
  if (n < 2) return null;
  const tieCorrection = tieGroups.reduce((acc, t) => acc + (t ** 3 - t), 0);
  const sigma = Math.sqrt(
    ((n1 * n2) / 12) * (n + 1 - tieCorrection / (n * (n - 1))),
  );
  if (!sigma) return null;
  const z = (u - mu) / sigma;
  return { u, z, p: 2 * (1 - normalCdf(Math.abs(z))) };
}

// ── Run records ─────────────────────────────────────────────────

/**
 * The metrics a comparison reports, in display order. `path` addresses a
 * field of a run record; `scale` converts to the display unit.
 */
export const METRICS = [
  { key: "peakRss", label: "Peak RSS", unit: "MB", scale: 1 / 1048576, path: ["memory", "process", "peakRssBytes"] },
  { key: "rss", label: "RSS at sample", unit: "MB", scale: 1 / 1048576, path: ["memory", "process", "rssBytes"] },
  { key: "anon", label: "Anonymous RSS", unit: "MB", scale: 1 / 1048576, path: ["memory", "process", "anonBytes"] },
  { key: "pss", label: "PSS", unit: "MB", scale: 1 / 1048576, path: ["pssBytes"] },
  { key: "heapUsed", label: "V8 live heap", unit: "MB", scale: 1 / 1048576, path: ["memory", "heap", "usedBytes"] },
  { key: "heapPhysical", label: "V8 heap committed", unit: "MB", scale: 1 / 1048576, path: ["memory", "heap", "physicalBytes"] },
  { key: "heapLimit", label: "V8 heap limit", unit: "MB", scale: 1 / 1048576, path: ["memory", "heap", "limitBytes"] },
  { key: "external", label: "V8 external", unit: "MB", scale: 1 / 1048576, path: ["memory", "heap", "externalBytes"] },
  { key: "toStarted", label: "Launch → started", unit: "s", scale: 1, path: ["durations", "started"] },
  { key: "toReady", label: "Launch → ready", unit: "s", scale: 1, path: ["durations", "ready"] },
];

/** @param {object} obj @param {string[]} path */
function pluck(obj, path) {
  let cursor = obj;
  for (const key of path) {
    if (cursor == null || typeof cursor !== "object") return undefined;
    cursor = cursor[key];
  }
  return typeof cursor === "number" ? cursor : undefined;
}

/**
 * Median/spread per metric for one series of runs.
 *
 * @param {object[]} runs
 */
export function summarise(runs) {
  const usable = runs.filter((run) => !run.failed);
  return {
    count: usable.length,
    failed: runs.length - usable.length,
    runtime: usable.find((run) => run.memory?.runtime)?.memory?.runtime ?? null,
    metrics: Object.fromEntries(
      METRICS.map((metric) => {
        const values = usable
          .map((run) => pluck(run, metric.path))
          .filter((v) => v !== undefined)
          .map((v) => v * metric.scale);
        return [
          metric.key,
          { median: median(values), stdev: stdev(values), n: values.length, values },
        ];
      }),
    ),
  };
}

/**
 * Compares two summarised series. `p` is omitted where either side has no
 * samples for that metric — an absent number is reported as absent rather
 * than as a zero difference.
 *
 * @param {ReturnType<typeof summarise>} baseline
 * @param {ReturnType<typeof summarise>} candidate
 */
export function compare(baseline, candidate) {
  return METRICS.map((metric) => {
    const a = baseline.metrics[metric.key];
    const b = candidate.metrics[metric.key];
    const test = a?.values.length && b?.values.length
      ? mannWhitneyU(a.values, b.values)
      : null;
    const delta =
      a?.median != null && b?.median != null ? b.median - a.median : null;
    return {
      ...metric,
      baseline: a?.median ?? null,
      candidate: b?.median ?? null,
      baselineStdev: a?.stdev ?? null,
      candidateStdev: b?.stdev ?? null,
      delta,
      percent:
        delta != null && a?.median ? (delta / a.median) * 100 : null,
      p: test?.p ?? null,
    };
  });
}

/**
 * Splits interleaved runs into per-round medians for one metric. Non-
 * overlapping per-round medians are the honest evidence that a difference is
 * the build and not host-load drift over the session.
 *
 * @param {object[]} runs
 * @param {string} metricKey
 */
export function perRoundMedians(runs, metricKey) {
  const metric = METRICS.find((m) => m.key === metricKey);
  if (!metric) return [];
  const rounds = [...new Set(runs.map((run) => run.round))].sort((a, b) => a - b);
  return rounds.map((round) => ({
    round,
    median: median(
      runs
        .filter((run) => run.round === round && !run.failed)
        .map((run) => pluck(run, metric.path))
        .filter((v) => v !== undefined)
        .map((v) => v * metric.scale),
    ),
  }));
}
