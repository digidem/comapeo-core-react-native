import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  bootDurations,
  compare,
  mannWhitneyU,
  median,
  parseLogcat,
  parseMeminfoPss,
  parseProcTimeline,
  perRoundMedians,
  stdev,
  summarise,
} from "./benchmark-core.mjs";

// Verbatim shapes from `adb logcat -v epoch` on a Pixel_7a_API_34 emulator
// running the integration app, trimmed to the lines the parser looks for.
const LOGCAT = `
         1787305093.601 17579 17579 I ComapeoCore: [comapeo.fgs] ComapeoCoreService.onCreate {category=comapeo.fgs}
         1787305093.712 17579 17579 I ComapeoCore: Starting the foreground service
         1787305093.744 17579 17579 I ComapeoCore: [comapeo.boot] start() {category=comapeo.boot}
         1787305093.902 17579 17579 I ComapeoCore: STOPPED → STARTING {from=STOPPED, to=STARTING}
         1787305095.858 17579 17667 I ComapeoCore: [comapeo.control] received: started {category=comapeo.control}
         1787305096.193 17579 17667 I ComapeoCore: [comapeo.control] received: ready {category=comapeo.control}
         1787305096.204 17579 17667 I ComapeoCore: STARTING → STARTED {from=STARTING, to=STARTED}
         1787305101.220 17579 17667 I Comapeo:NodeJS: [comapeo.memory] boot {"runtime":"24.19.0-0","heap":{"usedBytes":26654280,"physicalBytes":39010304,"totalBytes":43155456,"limitBytes":569114624,"externalBytes":10081445},"process":{"rssBytes":218136576,"peakRssBytes":280645632,"anonBytes":81002496,"fileBytes":101486592,"swapBytes":27136000}}
`;

const MEMINFO = `
Applications Memory Usage (in Kilobytes):
Uptime: 114629466 Realtime: 114629466

** MEMINFO in pid 22137 [com.comapeo.core.integration:ComapeoCore] **
                   Pss  Private  Private  SwapPss      Rss
                 Total    Dirty    Clean    Dirty    Total
                ------   ------   ------   ------   ------
  Native Heap    17556    17504       16       62    18596
     .so mmap      888      144        0       29    18628
        TOTAL   109205    64200    34836     1161   186256
`;

describe("parseLogcat", () => {
  it("extracts every boot milestone in epoch seconds", () => {
    const { milestones } = parseLogcat(LOGCAT);
    assert.equal(milestones.fgsCreate, 1787305093.601);
    assert.equal(milestones.foreground, 1787305093.712);
    assert.equal(milestones.nodeStart, 1787305093.744);
    assert.equal(milestones.started, 1787305095.858);
    assert.equal(milestones.ready, 1787305096.193);
    assert.equal(milestones.stateStarted, 1787305096.204);
  });

  it("does not mistake STOPPED → STARTING for the STARTED transition", () => {
    const { milestones } = parseLogcat(LOGCAT);
    assert.equal(milestones.stateStarted, 1787305096.204);
  });

  it("keeps the first occurrence of a milestone, not the last", () => {
    const doubled = LOGCAT + LOGCAT.replace(/1787305096\.193/, "1787305199.000");
    const { milestones } = parseLogcat(doubled);
    assert.equal(milestones.ready, 1787305096.193);
  });

  it("parses the backend boot memory snapshot", () => {
    const { memory, memoryEpoch } = parseLogcat(LOGCAT);
    assert.equal(memory.runtime, "24.19.0-0");
    assert.equal(memory.process.peakRssBytes, 280645632);
    assert.equal(memory.heap.physicalBytes, 39010304);
    assert.equal(memoryEpoch, 1787305101.220);
  });

  it("survives a truncated snapshot line", () => {
    const truncated =
      '  1787305101.220 1 1 I Comapeo:NodeJS: [comapeo.memory] boot {"runtime":"24.1\n';
    const { memory } = parseLogcat(truncated);
    assert.equal(memory, null);
  });

  it("returns empty results for unrelated output", () => {
    const { milestones, memory } = parseLogcat("--------- beginning of main\n");
    assert.deepEqual(milestones, {});
    assert.equal(memory, null);
  });
});

describe("bootDurations", () => {
  it("measures each milestone from the host-side launch timestamp", () => {
    const { milestones } = parseLogcat(LOGCAT);
    const durations = bootDurations(milestones, 1787305093.583);
    assert.ok(Math.abs(durations.ready - 2.61) < 0.001);
    assert.ok(Math.abs(durations.started - 2.275) < 0.001);
    assert.ok(durations.fgsCreate < durations.started);
  });

  it("omits milestones that never appeared", () => {
    const durations = bootDurations({ fgsCreate: 10 }, 9);
    assert.deepEqual(Object.keys(durations), ["fgsCreate"]);
  });
});

describe("parseMeminfoPss", () => {
  it("reads the TOTAL row's Pss Total column as bytes", () => {
    assert.equal(parseMeminfoPss(MEMINFO), 109205 * 1024);
  });

  it("returns null when the process was gone", () => {
    assert.equal(parseMeminfoPss("No process found for: 1234\n"), null);
  });
});

describe("parseProcTimeline", () => {
  it("converts kB columns to bytes", () => {
    const rows = parseProcTimeline("0.10 100 120 40 5\n0.15 110 130 45 5\n");
    assert.equal(rows.length, 2);
    assert.equal(rows[0].rssBytes, 100 * 1024);
    assert.equal(rows[1].peakRssBytes, 130 * 1024);
  });

  it("skips partial or non-numeric rows rather than poisoning the series", () => {
    const rows = parseProcTimeline("0.10 100 120 40 5\nbroken row here x\n0.2 1\n");
    assert.equal(rows.length, 1);
  });
});

describe("statistics", () => {
  it("median handles even and odd counts", () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(median([]), null);
  });

  it("stdev needs at least two samples", () => {
    assert.equal(stdev([1]), null);
    assert.ok(Math.abs(stdev([2, 4, 4, 4, 5, 5, 7, 9]) - 2.138) < 0.01);
  });

  it("mannWhitneyU separates two disjoint samples", () => {
    const result = mannWhitneyU([1, 2, 3, 4, 5], [11, 12, 13, 14, 15]);
    assert.ok(result.p < 0.01, `expected a small p, got ${result.p}`);
  });

  it("mannWhitneyU reports no difference for identical samples", () => {
    const result = mannWhitneyU([1, 2, 3], [1, 2, 3]);
    assert.ok(result.p > 0.9);
  });

  it("mannWhitneyU returns null when a sample is empty", () => {
    assert.equal(mannWhitneyU([], [1, 2]), null);
  });
});

/** @param {number} peak @param {number} ready */
function run(peak, ready, round = 1) {
  return {
    round,
    durations: { started: ready - 0.3, ready },
    pssBytes: 130 * 1048576,
    memory: {
      runtime: "24.19.0-0",
      heap: {
        usedBytes: 25 * 1048576,
        physicalBytes: 37 * 1048576,
        totalBytes: 41 * 1048576,
        limitBytes: 542 * 1048576,
        externalBytes: 9 * 1048576,
      },
      process: {
        rssBytes: 200 * 1048576,
        peakRssBytes: peak * 1048576,
        anonBytes: 100 * 1048576,
        swapBytes: 26 * 1048576,
      },
    },
  };
}

describe("summarise", () => {
  it("reports medians in display units and counts failures separately", () => {
    const summary = summarise([run(274, 1.9), run(275, 2.0), { failed: true }]);
    assert.equal(summary.count, 2);
    assert.equal(summary.failed, 1);
    assert.equal(summary.runtime, "24.19.0-0");
    assert.equal(summary.metrics.peakRss.median, 274.5);
    assert.equal(summary.metrics.toReady.median, 1.95);
    assert.equal(summary.metrics.heapUsed.median, 25);
  });

  it("yields a null median for a metric no run captured", () => {
    const summary = summarise([{ durations: { ready: 2 } }]);
    assert.equal(summary.metrics.peakRss.median, null);
    assert.equal(summary.metrics.toReady.median, 2);
  });
});

describe("compare", () => {
  it("reports delta, percent and p per metric", () => {
    const baseline = summarise([run(274, 1.9), run(275, 1.9), run(274, 2.0)]);
    const candidate = summarise([run(261, 1.8), run(261, 1.8), run(262, 1.8)]);
    const rows = compare(baseline, candidate);
    const peak = rows.find((row) => row.key === "peakRss");
    assert.equal(peak.baseline, 274);
    assert.equal(peak.candidate, 261);
    assert.equal(peak.delta, -13);
    assert.ok(Math.abs(peak.percent + 4.74) < 0.01);
    assert.ok(peak.p < 0.1);
  });

  it("leaves delta and p null where one side has no samples", () => {
    const rows = compare(summarise([run(274, 1.9)]), summarise([{ failed: true }]));
    const peak = rows.find((row) => row.key === "peakRss");
    assert.equal(peak.delta, null);
    assert.equal(peak.p, null);
  });
});

describe("perRoundMedians", () => {
  it("groups by interleaving round so drift is visible", () => {
    const rows = perRoundMedians(
      [run(274, 1.9, 1), run(275, 1.9, 1), run(281, 1.9, 2), run(283, 1.9, 2)],
      "peakRss",
    );
    assert.deepEqual(rows, [
      { round: 1, median: 274.5 },
      { round: 2, median: 282 },
    ]);
  });
});
