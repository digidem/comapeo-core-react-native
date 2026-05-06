# Benchmark Results

This file is the curated summary of UDS / RPC bridge benchmark runs
across devices. Raw NDJSON span files (one per `runId`) live in
`apps/benchmark/results/` and are gitignored — copy into a run entry
below if you want to keep specific traces.

Each run section captures one `npm run bench:browserstack` invocation
across one or more devices, plus enough context (build URL, dates,
git SHA, app version) to make it reproducible later.

## Format

| Column | Meaning |
|---|---|
| `device` | BrowserStack device name + OS version |
| `size` | Payload size for the `payload(sizeBytes)` RPC |
| `n` | Sample count (warmup excluded) |
| `p50` / `p95` / `p99` | RN-thread RTT percentiles in ms |
| `min` / `max` | Bounds across samples |

Boot-phase rows use `phase` instead of `size` and have a single
duration measurement per phase (no percentiles).

## Variance — what to expect from p99 vs p50

The first single-device run showed p99 ≈ 6× p50 at 64 B payloads, which
prompted the question of whether that's normal. The 19-device sweep
below confirms: **p99/p50 ratios of 2–6× are typical for cross-process
IPC microbenchmarks on real Android hardware** and reflect the jitter
floor of OS scheduler + runtime, not a defect in the bridge.

Empirical pattern across the sweep (64 B payload, 100 samples per
device):

| device class | example | p50 | p99 | ratio |
|---|---|---:|---:|---:|
| recent flagship (Android 16) | Samsung S26 Ultra | 0.83 ms | 2.24 ms | 2.7× |
| recent flagship (Android 16) | Pixel 10 Pro | 2.05 ms | 7.54 ms | 3.7× |
| recent flagship (Android 15) | OnePlus 13R | 1.67 ms | 5.86 ms | 3.5× |
| mid-range (Android 11) | OnePlus 9 (LE2113) | 1.92 ms | 5.65 ms | 2.9× |
| mid-range (Android 11) | OPPO Reno 6 | 4.82 ms | 14.2 ms | 2.9× |
| budget (Android 10) | Samsung A51 | 5.18 ms | 9.67 ms | 1.9× |
| budget (Android 11) | Vivo Y21 | 11.3 ms | 37.6 ms | 3.3× |
| old (Android 9) | Huawei P30 | 15.3 ms | 63.4 ms | 4.1× |

What's contributing to that spread, in roughly decreasing order of
expected impact:

1. **Scheduler preemption.** Other processes (system services,
   notification listeners, sensor managers) compete for CPU. Even on
   an "idle" BS device, hundreds of background threads can preempt
   the bench app's hot loop for sub-ms windows. Cumulative across
   100 samples, this is the dominant noise floor.
2. **GC pauses.** Both V8 (nodejs-mobile) and the RN JS thread can
   stop briefly to collect. Per-RPC allocations are small (one
   request object + one response string) but 100 iterations × 3
   sizes is enough to trigger young-gen sweeps.
3. **CPU frequency scaling.** Android cores ramp up/down on demand.
   Right after Maestro taps "Run benchmark", the relevant cores are
   often at low-frequency idle; the first few RPCs hit a scaling
   transient. On budget devices with aggressive scaling, this shows
   up as elevated min/p50 and a wider p95–p99 tail.
4. **Tail outliers from system events.** A single touch event,
   network packet, or sensor frame interrupt during one of the 100
   measurement RPCs lands at p99 by construction.

The Samsung S26 Ultra (Android 16, top-end SoC) shows the tightest
distribution at 2.7× p99/p50 — the floor is low (sub-ms) AND the
jitter envelope is narrow. Older/budget devices have both higher
absolute floors (slower hardware) and wider tails (more aggressive
power management + smaller CPU caches).

**Min** is the closest reading we have to "the actual IPC cost
without OS interference." For 64 B that ranges from 0.4 ms (S26 Ultra)
to 6.7 ms (Huawei Nova 11 SE), so on every device, the framing /
JSI / UDS path itself is sub-ms-to-low-ms; everything above min is
runtime/OS noise.

### Boot-phase wiring (resolved)

Earlier dispatches had a known gap: boot spans never reached the
host receiver because nodejs-mobile's libuv socket traffic bypasses
BrowserStackLocal's tunnel. The Phase 4 follow-up replaced the
HTTP-tunnel transport with logcat — both span sources now write
`BENCH_SPAN <json>` lines to stdout, which surface in Android
logcat (under `Comapeo:NodeJS` for backend, `ReactNativeJS` for
RN-side), and the dispatch script pulls + parses them after the
build finishes. Boot spans are present in subsequent runs.

## Runs

<!-- Add new runs at the top. -->

### 2026-05-06 — first cross-platform sweep with logcat + ingestSpans (11 devices)

> **Date:** 2026-05-06 &nbsp;·&nbsp; **Git SHA:** *post-`b1efb15`* &nbsp;·&nbsp;
> **Builds:**
> [Android](https://app-automate.browserstack.com/dashboard/v2/builds/0438afd4b8d4aee1262150f2a90a5c2448f6ab66),
> [iOS](https://app-automate.browserstack.com/dashboard/v2/builds/cd6aa48ff009b2badfb2c9d6e963f905cf01e3da)
> &nbsp;·&nbsp; **Flow:** `bench-rpc.yaml`
> &nbsp;·&nbsp; **Devices:** curated 10-device Android sweep + iPhone 15 (iOS 17).

> **Notes:** First sweep with the new logcat-based span transport AND
> the iOS path enabled. RN-side spans flow through a single
> `ingestSpans` RPC call to the bench backend after each run; the
> backend re-emits via `console.log` which goes through stdout →
> Android logcat / iOS `os_log` (via the `pipe + dup2` redirect in
> `NodeMobileBridge.mm`). All 11 sessions passed; 6542 spans
> collected end-to-end; the autosummary table below is regenerated
> from `apps/benchmark/results/*.ndjson` via
> `npm run bench:summarize`. iPhone (iOS 17.3) shows the tightest
> distribution at ~4× p99/p50 ratio, sub-ms p50 on all sizes.

### 2026-05-06 — multi-device sweep (19 devices)

> **Date:** 2026-05-06 &nbsp;·&nbsp; **Git SHA:** `7c08575+` &nbsp;·&nbsp;
> **Builds:**
> [batch 1](https://app-automate.browserstack.com/dashboard/v2/builds/61e40995d1ca8352d10d20b640424a8a6ea12c29),
> [batch 2](https://app-automate.browserstack.com/dashboard/v2/builds/45d39271d3598afe1ecc2ac1d2e50995f1d83e53)
> &nbsp;·&nbsp; **Flow:** `bench-rpc-receiver.yaml`
> &nbsp;·&nbsp; **Devices:** all 14 non-Samsung non-Pixel Android devices in the BS catalog + 3 Samsung (S26 Ultra / S22 / A51) + 2 Pixel (10 Pro / 7).

> **Notes:** First sweep with span aggregation across the fleet.
> Plan parallel cap is 5 + 5 queued, so 19 devices ran as 10 + 9.
> All 19 sessions passed. ~98% RPC span capture (5656 / 5700
> expected); minor loss from in-flight POSTs at process exit on the
> fastest-finishing devices. Live numbers in the auto-summary
> below; variance analysis above.

### 2026-05-05 — first real BrowserStack run (Samsung Galaxy S23 Ultra)

> **Date:** 2026-05-05 &nbsp;·&nbsp; **Git SHA:** `7c08575` &nbsp;·&nbsp;
> **Build:** [BS dashboard](https://app-automate.browserstack.com/dashboard/v2/builds/f73297b5730f44a71f39c207848633731e8c754a) &nbsp;·&nbsp;
> **Flow:** `bench-rpc-receiver.yaml` &nbsp;·&nbsp;
> **APK:** release variant, debug-keystore signed &nbsp;·&nbsp;
> **runId:** `1778018703688-8h54fc`

#### RPC throughput (RN-thread RTT)

| device | size | n | min | p50 | p95 | p99 | max |
|---|---|---:|---:|---:|---:|---:|---:|
| Samsung Galaxy S23 Ultra (Android 13) | 64 B | 100 | 0.38 | 0.55 | 1.83 | 3.22 | 5.40 |
| Samsung Galaxy S23 Ultra (Android 13) | 1 KB | 100 | 0.41 | 0.68 | 1.36 | 2.41 | 5.17 |
| Samsung Galaxy S23 Ultra (Android 13) | 64 KB | 100 | 1.40 | 1.77 | 4.47 | 5.36 | 11.26 |

> **Notes:** First end-to-end run with BrowserStackLocal + receiver
> wired. Sub-ms p50 across all small payload sizes; p99 well under
> 6 ms for ≤1 KB. 64 KB scales as expected (~3× p50, but still
> sub-2 ms median). Boot-phase spans aren't yet wired into the
> receiver path — only `op:"rpc"` was captured this run.

### Template (copy this when filling in a real run)

> **Date:** YYYY-MM-DD &nbsp;·&nbsp; **Git SHA:** `<sha>` &nbsp;·&nbsp;
> **Build:** [BS dashboard](https://app-automate.browserstack.com/dashboard/v2/builds/<build_id>) &nbsp;·&nbsp;
> **Flow:** `bench-rpc-receiver.yaml`

#### RPC throughput

| device | size | n | p50 | p95 | p99 | min | max |
|---|---|---:|---:|---:|---:|---:|---:|
| Samsung Galaxy S23 Ultra (Android 13) | 64 B | 100 | – | – | – | – | – |
| Samsung Galaxy S23 Ultra (Android 13) | 1 KB | 100 | – | – | – | – | – |
| Samsung Galaxy S23 Ultra (Android 13) | 64 KB | 100 | – | – | – | – | – |
| iPhone 15 (iOS 17) | 64 B | 100 | – | – | – | – | – |
| iPhone 15 (iOS 17) | 1 KB | 100 | – | – | – | – | – |
| iPhone 15 (iOS 17) | 64 KB | 100 | – | – | – | – | – |

#### Boot phases

| device | phase | duration (ms) |
|---|---|---:|
| Samsung Galaxy S23 Ultra (Android 13) | boot.listen-control | – |
| Samsung Galaxy S23 Ultra (Android 13) | boot.init | – |
| Samsung Galaxy S23 Ultra (Android 13) | boot.construct | – |

> **Notes:** anything noteworthy about this run — outliers,
> simulator-vs-device caveats, regressions vs prior run, etc.

<!-- BEGIN AUTOSUMMARY -->
_Generated by `scripts/bench-summarize.ts` from `apps/benchmark/results/` at 2026-05-06T13:34:41.369Z — 6542 spans across 11 devices._

#### RPC throughput (RN-thread RTT, ms)

| device | size | n | min | p50 | p95 | p99 | max |
|---|---|---:|---:|---:|---:|---:|---:|
| Apple iPhone (iOS 17.3) | 64 B | 100 | 0.13 | 0.19 | 0.51 | 0.75 | 3.35 |
| Apple iPhone (iOS 17.3) | 1 KB | 100 | 0.11 | 0.13 | 0.21 | 0.84 | 1.71 |
| Apple iPhone (iOS 17.3) | 64 KB | 100 | 0.54 | 0.60 | 0.78 | 0.89 | 1.45 |
| Google Pixel 10 Pro (Android 16) | 64 B | 98 | 1.06 | 1.37 | 2.13 | 3.89 | 5.32 |
| Google Pixel 10 Pro (Android 16) | 1 KB | 94 | 1.02 | 1.40 | 2.88 | 3.48 | 4.85 |
| Google Pixel 10 Pro (Android 16) | 64 KB | 97 | 2.87 | 4.37 | 6.57 | 12.7 | 16.7 |
| Google Pixel 7 (Android 13) | 64 B | 96 | 0.78 | 1.16 | 2.47 | 3.70 | 5.03 |
| Google Pixel 7 (Android 13) | 1 KB | 100 | 0.75 | 1.11 | 1.77 | 5.90 | 8.37 |
| Google Pixel 7 (Android 13) | 64 KB | 100 | 2.14 | 4.41 | 7.14 | 13.4 | 16.4 |
| HUAWEI ELE-L09 (Android 9) | 64 B | 91 | 1.07 | 2.03 | 4.53 | 6.46 | 11.7 |
| HUAWEI ELE-L09 (Android 9) | 1 KB | 90 | 1.14 | 1.72 | 2.94 | 4.25 | 6.08 |
| HUAWEI ELE-L09 (Android 9) | 64 KB | 91 | 3.03 | 5.94 | 9.70 | 11.3 | 16.9 |
| OnePlus CPH2585 (Android 14) | 64 B | 100 | 0.62 | 0.93 | 1.46 | 1.84 | 2.63 |
| OnePlus CPH2585 (Android 14) | 1 KB | 100 | 0.74 | 1.70 | 3.19 | 3.37 | 4.20 |
| OnePlus CPH2585 (Android 14) | 64 KB | 100 | 1.90 | 3.19 | 6.24 | 7.21 | 8.60 |
| samsung SM-A515F (Android 10) | 64 B | 100 | 1.99 | 3.07 | 6.42 | 9.15 | 9.43 |
| samsung SM-A515F (Android 10) | 1 KB | 95 | 2.24 | 3.26 | 7.04 | 7.49 | 7.65 |
| samsung SM-A515F (Android 10) | 64 KB | 98 | 5.28 | 6.31 | 8.93 | 12.3 | 13.2 |
| samsung SM-S901B (Android 12) | 64 B | 100 | 1.79 | 2.77 | 6.30 | 8.96 | 14.5 |
| samsung SM-S901B (Android 12) | 1 KB | 100 | 1.20 | 2.73 | 5.27 | 10.4 | 11.5 |
| samsung SM-S901B (Android 12) | 64 KB | 100 | 2.25 | 6.40 | 12.3 | 15.7 | 20.1 |
| samsung SM-S948B (Android 16) | 64 B | 100 | 0.23 | 0.33 | 0.56 | 0.78 | 2.14 |
| samsung SM-S948B (Android 16) | 1 KB | 100 | 0.22 | 0.35 | 0.57 | 1.58 | 1.66 |
| samsung SM-S948B (Android 16) | 64 KB | 99 | 1.05 | 1.43 | 1.79 | 2.08 | 2.38 |
| vivo V2111 (Android 11) | 64 B | 89 | 3.58 | 4.48 | 6.90 | 9.21 | 9.56 |
| vivo V2111 (Android 11) | 1 KB | 89 | 3.74 | 4.45 | 6.13 | 9.34 | 9.75 |
| vivo V2111 (Android 11) | 64 KB | 83 | 9.09 | 10.6 | 12.7 | 12.9 | 13.5 |
| Xiaomi 2201117TI (Android 11) | 64 B | 90 | 0.96 | 1.67 | 3.51 | 5.45 | 7.62 |
| Xiaomi 2201117TI (Android 11) | 1 KB | 98 | 1.47 | 2.97 | 4.79 | 5.35 | 7.54 |
| Xiaomi 2201117TI (Android 11) | 64 KB | 100 | 4.43 | 6.89 | 10.6 | 14.4 | 17.9 |

#### Boot phases (server-side, ms)

| device | phase | n | min | median | max |
|---|---|---:|---:|---:|---:|
| Apple iPhone (iOS 17.3) | boot.construct | 1 | 0.13 | 0.13 | 0.13 |
| Apple iPhone (iOS 17.3) | boot.init | 1 | 23.4 | 23.4 | 23.4 |
| Apple iPhone (iOS 17.3) | boot.listen-control | 1 | 2.46 | 2.46 | 2.46 |
| Google Pixel 10 Pro (Android 16) | boot.construct | 1 | 0.54 | 0.54 | 0.54 |
| Google Pixel 10 Pro (Android 16) | boot.init | 1 | 40.9 | 40.9 | 40.9 |
| Google Pixel 10 Pro (Android 16) | boot.listen-control | 1 | 7.23 | 7.23 | 7.23 |
| Google Pixel 7 (Android 13) | boot.construct | 1 | 0.55 | 0.55 | 0.55 |
| Google Pixel 7 (Android 13) | boot.init | 1 | 48.8 | 48.8 | 48.8 |
| Google Pixel 7 (Android 13) | boot.listen-control | 1 | 15.7 | 15.7 | 15.7 |
| HUAWEI ELE-L09 (Android 9) | boot.construct | 1 | 0.67 | 0.67 | 0.67 |
| HUAWEI ELE-L09 (Android 9) | boot.init | 1 | 54.6 | 54.6 | 54.6 |
| HUAWEI ELE-L09 (Android 9) | boot.listen-control | 1 | 10.4 | 10.4 | 10.4 |
| OnePlus CPH2585 (Android 14) | boot.construct | 1 | 0.39 | 0.39 | 0.39 |
| OnePlus CPH2585 (Android 14) | boot.init | 1 | 39.3 | 39.3 | 39.3 |
| OnePlus CPH2585 (Android 14) | boot.listen-control | 1 | 4.26 | 4.26 | 4.26 |
| OnePlus CPH2691 (Android 15) | boot.construct | 1 | 0.27 | 0.27 | 0.27 |
| OnePlus CPH2691 (Android 15) | boot.init | 1 | 9.67 | 9.67 | 9.67 |
| OnePlus CPH2691 (Android 15) | boot.listen-control | 1 | 4.58 | 4.58 | 4.58 |
| samsung SM-A515F (Android 10) | boot.construct | 1 | 1.80 | 1.80 | 1.80 |
| samsung SM-A515F (Android 10) | boot.init | 1 | 40.2 | 40.2 | 40.2 |
| samsung SM-A515F (Android 10) | boot.listen-control | 1 | 26.8 | 26.8 | 26.8 |
| samsung SM-S901B (Android 12) | boot.construct | 1 | 0.41 | 0.41 | 0.41 |
| samsung SM-S901B (Android 12) | boot.init | 1 | 17.9 | 17.9 | 17.9 |
| samsung SM-S901B (Android 12) | boot.listen-control | 1 | 5.93 | 5.93 | 5.93 |
| samsung SM-S948B (Android 16) | boot.construct | 1 | 0.42 | 0.42 | 0.42 |
| samsung SM-S948B (Android 16) | boot.init | 1 | 18.7 | 18.7 | 18.7 |
| samsung SM-S948B (Android 16) | boot.listen-control | 1 | 4.03 | 4.03 | 4.03 |
| vivo V2111 (Android 11) | boot.construct | 1 | 2.29 | 2.29 | 2.29 |
| vivo V2111 (Android 11) | boot.init | 1 | 78.8 | 78.8 | 78.8 |
| vivo V2111 (Android 11) | boot.listen-control | 1 | 40.3 | 40.3 | 40.3 |
| Xiaomi 2201117TI (Android 11) | boot.construct | 1 | 4.91 | 4.91 | 4.91 |
| Xiaomi 2201117TI (Android 11) | boot.init | 1 | 89.4 | 89.4 | 89.4 |
| Xiaomi 2201117TI (Android 11) | boot.listen-control | 1 | 18.3 | 18.3 | 18.3 |

<!-- END AUTOSUMMARY -->
