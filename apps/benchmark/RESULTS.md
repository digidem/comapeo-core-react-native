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

### Boot-phase wiring caveat

The summarizer table below shows _no boot spans found_. The bench
backend's HttpSink fires `boot.<phase>` POSTs from inside
nodejs-mobile, and BrowserStack Local doesn't appear to tunnel
nodejs-mobile's libuv socket traffic the same way it tunnels the
RN-side `fetch()`. RN-side rpc spans still arrive cleanly (5656 of
~5700 expected); only the server-side boot spans drop. Tracking
this as a known gap; likely fix is to forward boot phases through
the existing control socket back to RN, then up the same fetch path
the rpc spans use.

## Runs

<!-- Add new runs at the top. -->

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
_Generated by `scripts/bench-summarize.ts` from `apps/benchmark/results/` at 2026-05-06T09:11:04.451Z — 5656 spans across 19 devices._

#### RPC throughput (RN-thread RTT, ms)

| device | size | n | min | p50 | p95 | p99 | max |
|---|---|---:|---:|---:|---:|---:|---:|
| Google Pixel 10 Pro (Android 16) | 64 B | 100 | 1.04 | 2.05 | 5.69 | 7.54 | 9.78 |
| Google Pixel 10 Pro (Android 16) | 1 KB | 100 | 0.79 | 1.60 | 2.81 | 5.34 | 6.31 |
| Google Pixel 10 Pro (Android 16) | 64 KB | 100 | 2.00 | 3.72 | 6.52 | 8.72 | 14.8 |
| Google Pixel 7 (Android 13) | 64 B | 100 | 1.32 | 2.47 | 6.43 | 8.72 | 15.4 |
| Google Pixel 7 (Android 13) | 1 KB | 100 | 1.06 | 1.97 | 4.97 | 10.4 | 11.6 |
| Google Pixel 7 (Android 13) | 64 KB | 100 | 2.55 | 3.55 | 7.45 | 8.00 | 8.16 |
| HUAWEI BON-AL00 (Android 12) | 64 B | 100 | 6.69 | 10.7 | 19.5 | 21.0 | 25.5 |
| HUAWEI BON-AL00 (Android 12) | 1 KB | 100 | 6.60 | 10.7 | 19.8 | 43.0 | 51.9 |
| HUAWEI BON-AL00 (Android 12) | 64 KB | 100 | 11.0 | 25.8 | 49.6 | 64.0 | 73.0 |
| HUAWEI ELE-L09 (Android 9) | 64 B | 100 | 4.54 | 15.3 | 43.0 | 63.4 | 74.7 |
| HUAWEI ELE-L09 (Android 9) | 1 KB | 100 | 4.42 | 13.5 | 32.3 | 44.7 | 54.5 |
| HUAWEI ELE-L09 (Android 9) | 64 KB | 100 | 10.8 | 21.8 | 60.3 | 76.6 | 87.7 |
| motorola moto g(9) play (Android 10) | 64 B | 100 | 3.57 | 4.87 | 8.91 | 10.1 | 13.7 |
| motorola moto g(9) play (Android 10) | 1 KB | 100 | 3.53 | 4.89 | 11.7 | 19.6 | 23.9 |
| motorola moto g(9) play (Android 10) | 64 KB | 100 | 6.46 | 8.91 | 19.3 | 26.5 | 26.7 |
| motorola moto g71 5G (Android 11) | 64 B | 100 | 2.08 | 3.08 | 6.28 | 8.78 | 9.49 |
| motorola moto g71 5G (Android 11) | 1 KB | 100 | 1.80 | 2.92 | 5.35 | 9.14 | 13.7 |
| motorola moto g71 5G (Android 11) | 64 KB | 100 | 3.31 | 4.25 | 7.88 | 11.6 | 22.0 |
| OnePlus CPH2487 (Android 13) | 64 B | 100 | 1.12 | 2.45 | 4.50 | 5.97 | 8.89 |
| OnePlus CPH2487 (Android 13) | 1 KB | 100 | 0.81 | 1.95 | 4.42 | 10.9 | 11.8 |
| OnePlus CPH2487 (Android 13) | 64 KB | 100 | 2.22 | 4.39 | 10.7 | 14.1 | 25.9 |
| OnePlus CPH2585 (Android 14) | 64 B | 100 | 1.00 | 1.83 | 3.82 | 7.09 | 7.79 |
| OnePlus CPH2585 (Android 14) | 1 KB | 100 | 0.93 | 1.71 | 4.07 | 5.21 | 5.83 |
| OnePlus CPH2585 (Android 14) | 64 KB | 100 | 2.12 | 3.09 | 4.76 | 6.25 | 8.01 |
| OnePlus CPH2691 (Android 15) | 64 B | 100 | 0.63 | 1.67 | 3.53 | 5.86 | 8.88 |
| OnePlus CPH2691 (Android 15) | 1 KB | 100 | 0.78 | 1.64 | 3.84 | 6.36 | 7.88 |
| OnePlus CPH2691 (Android 15) | 64 KB | 56 | 1.56 | 2.74 | 4.47 | 5.23 | 5.75 |
| OnePlus LE2113 (Android 11) | 64 B | 100 | 1.16 | 1.92 | 4.25 | 5.65 | 5.70 |
| OnePlus LE2113 (Android 11) | 1 KB | 100 | 1.25 | 1.76 | 3.01 | 4.56 | 5.48 |
| OnePlus LE2113 (Android 11) | 64 KB | 100 | 2.25 | 3.19 | 4.95 | 5.68 | 8.65 |
| OPPO CPH2035 (Android 10) | 64 B | 100 | 3.30 | 4.97 | 9.71 | 11.5 | 13.6 |
| OPPO CPH2035 (Android 10) | 1 KB | 100 | 3.27 | 4.61 | 9.13 | 11.6 | 14.6 |
| OPPO CPH2035 (Android 10) | 64 KB | 100 | 4.85 | 6.90 | 10.9 | 16.2 | 20.8 |
| OPPO CPH2251 (Android 11) | 64 B | 100 | 1.78 | 4.82 | 9.71 | 14.2 | 16.2 |
| OPPO CPH2251 (Android 11) | 1 KB | 100 | 1.54 | 3.17 | 7.36 | 11.4 | 26.5 |
| OPPO CPH2251 (Android 11) | 64 KB | 100 | 3.45 | 6.78 | 12.8 | 15.1 | 23.2 |
| samsung SM-A515F (Android 10) | 64 B | 100 | 3.78 | 5.18 | 8.58 | 9.67 | 13.5 |
| samsung SM-A515F (Android 10) | 1 KB | 100 | 3.51 | 4.85 | 9.11 | 12.5 | 13.5 |
| samsung SM-A515F (Android 10) | 64 KB | 100 | 6.10 | 8.60 | 12.3 | 14.6 | 19.3 |
| samsung SM-S901B (Android 12) | 64 B | 100 | 1.37 | 3.00 | 10.2 | 13.4 | 22.5 |
| samsung SM-S901B (Android 12) | 1 KB | 100 | 1.39 | 2.80 | 7.42 | 9.32 | 9.99 |
| samsung SM-S901B (Android 12) | 64 KB | 100 | 2.94 | 5.71 | 11.3 | 15.7 | 19.9 |
| samsung SM-S948B (Android 16) | 64 B | 100 | 0.47 | 0.83 | 1.85 | 2.24 | 2.47 |
| samsung SM-S948B (Android 16) | 1 KB | 100 | 0.40 | 0.62 | 1.27 | 2.40 | 2.44 |
| samsung SM-S948B (Android 16) | 64 KB | 100 | 1.48 | 1.83 | 2.43 | 2.98 | 3.01 |
| vivo V2050 (Android 11) | 64 B | 100 | 4.06 | 6.47 | 12.6 | 14.5 | 14.9 |
| vivo V2050 (Android 11) | 1 KB | 100 | 3.77 | 6.10 | 11.4 | 13.3 | 15.2 |
| vivo V2050 (Android 11) | 64 KB | 100 | 7.50 | 9.94 | 14.6 | 16.4 | 18.7 |
| vivo V2111 (Android 11) | 64 B | 100 | 6.58 | 11.3 | 18.4 | 37.6 | 46.6 |
| vivo V2111 (Android 11) | 1 KB | 100 | 6.32 | 10.0 | 23.1 | 30.6 | 33.0 |
| vivo V2111 (Android 11) | 64 KB | 100 | 11.5 | 15.4 | 28.4 | 34.4 | 48.0 |
| Xiaomi 2201117TI (Android 11) | 64 B | 100 | 2.27 | 3.99 | 8.44 | 9.89 | 12.8 |
| Xiaomi 2201117TI (Android 11) | 1 KB | 100 | 2.18 | 3.66 | 6.32 | 8.02 | 9.98 |
| Xiaomi 2201117TI (Android 11) | 64 KB | 100 | 4.89 | 6.13 | 9.14 | 15.0 | 17.8 |
| Xiaomi M2003J15SC (Android 10) | 64 B | 100 | 3.48 | 5.38 | 10.8 | 13.1 | 20.4 |
| Xiaomi M2003J15SC (Android 10) | 1 KB | 100 | 3.14 | 4.93 | 15.6 | 21.1 | 21.7 |
| Xiaomi M2003J15SC (Android 10) | 64 KB | 100 | 5.82 | 8.10 | 18.4 | 22.8 | 26.7 |

#### Boot phases (server-side, ms)

_(no boot spans found)_

<!-- END AUTOSUMMARY -->
