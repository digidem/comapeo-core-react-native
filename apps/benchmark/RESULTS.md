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

## Runs

<!-- Add new runs at the top. -->

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
