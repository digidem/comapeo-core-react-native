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
