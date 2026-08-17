# Backend memory monitoring plan

Goal: get enough memory telemetry out of the embedded Node backend to (a)
characterise the **startup** memory profile, (b) detect **leaks** and **GC
pressure** in the field, and (c) choose `--max-old-space-size` and the other V8
flags from data rather than guesswork — without measurably costing battery, CPU
or Sentry volume.

Status: **plan only**. Nothing here is implemented yet. Section 8 is the
implementation order.

---

## 1. What we monitor today

The whole memory surface is three things.

### 1.1 `comapeo.backend.heap_used_bytes` — one gauge, once a minute

`backend/index.js` `startMemorySampler()` starts a 60 s `setInterval` (unref'd,
skipped entirely when Sentry is off) at the moment boot reaches `ready`. Each
tick calls `metrics.backendMemorySample()`, which emits a single gauge:

```js
// backend/lib/metrics.js
const mem = process.memoryUsage();
gauge("comapeo.backend.heap_used_bytes", mem.heapUsed, "byte", {});
```

That is the entirety of backend memory reporting. Note what it is _not_:

- **No `rss`.** Deliberately dropped, with the reasoning recorded in the doc
  comment: on iOS Node runs in-process, so `rss` is the whole app, not "the
  backend". Correct for iOS — but it also removed the number on **Android**,
  where the backend _is_ its own `:ComapeoCore` process and `rss` measures
  exactly the thing we care about. See §3.1.
- **No `heapTotal`, `external`, `arrayBuffers`.** `process.memoryUsage()` is
  called and four of its five fields are thrown away. `external` +
  `arrayBuffers` is where sodium-native, better-sqlite3 and hypercore buffers
  live — memory that `--max-old-space-size` does **not** bound.
- **No `heap_size_limit`.** We have never recorded the number
  `--max-old-space-size` would be overriding, on any device.
- **No GC data at all.**
- **No attributes.** The gauge carries only the global `platform` tag — not
  even `device_class` / `os_major`, which the duration metrics get. A heap
  number that can't be sliced by device class can't answer "which devices are
  near the limit".
- **Instantaneous, not aggregated.** One `heapUsed` read every 60 s, taken at
  an arbitrary point in the GC sawtooth. It could land just before a
  mark-sweep (near peak) or just after (near floor); we can't tell which.

### 1.2 `comapeo.backend.event_loop_delay_ms` — adjacent, not memory

Same 60 s tick emits the window max from `monitorEventLoopDelay`. Useful as
corroboration (GC thrash shows up as event-loop stalls) but it can't
distinguish a GC pause from a slow sync handler.

### 1.3 Post-mortem memory signals from the native side

These are good, and they're the reason we know memory kills happen at all:

| Platform | Source                                                           | What we get                                                                                                                                                                                        |
| -------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Android  | `ExitReasonsCollector.kt` → `getHistoricalProcessExitReasons`    | Per-death `pss_kb`, `rss_kb`, `REASON_LOW_MEMORY` → `exit_reason=low_memory`, OEM-killer heuristics, uptime/backgrounded buckets. Reported on the _next_ process start, for both `main` and `fgs`. |
| iOS      | `AppExitMetricsCollector.swift` → MetricKit `MXAppExitMetric`    | 24 h bucket counts for `memory_resource_limit`, `memory_pressure`, mapped to `exit_cause_class=memory`.                                                                                            |
| Both     | `node_resources` event context (`backend/lib/node-resources.js`) | Capture-time `os.freemem()` / `os.totalmem()` + free disk, stamped on backend **events only** (not metrics), usage-tier gated.                                                                     |
| Both     | Device scope                                                     | `memory_size` (total device RAM) survives the diagnostics scope tier, so fleet slicing by RAM is already possible.                                                                                 |

So: **we know the fleet dies of memory, and roughly how big the process was
when it died — but we have no time series leading up to the death, no heap
composition, and no idea how much headroom V8 thought it had.**

### 1.4 No Node memory flags are set

Neither platform passes any V8 memory flag. The full argv is:

```swift
// ios/NodeJSService.swift
var args: [String] = ["node", "--no-experimental-fetch"]
args.append(contentsOf: [jsPath, comapeoSocketPath, controlSocketPath,
                         privateStorageDir, defaultConfigPath, defaultOnlineStyleUrl])
args.append(contentsOf: buildSentryArgs())
```

Android's `buildBackendArgs()` mirrors it. So V8 picks its own heap limit from
physical memory at isolate creation — a desktop-derived heuristic that on a
4 GB phone typically lands in the ~1–2 GB range, i.e. far above what either
Android's lmkd or iOS's jetsam will actually let us keep. **The default limit
is almost certainly never reached: the OS kills us first.** That is precisely
why setting it explicitly is worth doing, and why step one is measuring
`heap_size_limit` on real devices.

### 1.5 Documentation inconsistency to fix in passing

`docs/sentry-integration.md` contradicts itself and the code: §7.3.8 (line
~1113) lists "Backend memory/heap snapshots (periodic)" as **Opt-in**, while
§9.2 (line ~1424) lists "Backend health gauges (memory, heap, uptime,
event-loop delay)" as **Diagnostics**. The code is diagnostics-tier
(`backendMemorySample` is not gated on `applicationUsageData`). §9.2 is right;
§7.3.8's row is stale.

---

## 2. Gaps, ranked by what they cost us

1. **Startup is entirely unmonitored.** The sampler starts _after_ `ready`.
   Everything before that — V8 init, the Sentry SDK chunk import, `index.js`
   module graph, `MapeoManager` construction, drizzle migrations, map server —
   is invisible. Startup is where peak memory usually is, and on Android it is
   the window where the FGS is most likely to be killed.
2. **No heap limit / headroom.** We can't answer "how close to OOM is the
   fleet?" or "what would `--max-old-space-size=N` actually change?"
3. **No GC signal.** Can't distinguish "heap is big" (fine) from "heap is big
   _and_ V8 is collecting constantly to stay there" (a too-small limit, or a
   leak). GC duty cycle is the single best indicator that a heap limit is set
   wrong.
4. **No leak signal.** One instantaneous sample per minute, taken at a random
   phase of the sawtooth, is too noisy to fit a trend against.
5. **Off-heap invisible.** `external` + `arrayBuffers` is likely a large share
   of this backend's footprint (sodium, sqlite, hypercore blocks) and is
   completely unbounded by `--max-old-space-size`. Tuning the old-space limit
   without knowing the off-heap share risks tuning the wrong knob.
6. **No RSS on Android**, where RSS is exactly the right number.
7. **No iOS footprint / jetsam headroom.** `os_proc_available_memory()` gives
   bytes remaining before jetsam directly. We don't read it.
8. **No pre-OOM capture.** A V8 heap-limit OOM aborts the process; no JS
   callback runs, no Sentry event is emitted from Node. We find out only via
   the next launch's exit-reason record.

---

## 3. Design

Two principles carry most of the design.

### Principle A — decouple _sampling_ rate from _emission_ rate

Sampling is free (§7: ~6 µs); emitting is what costs Sentry volume and
battery. So: **sample at 1 Hz, emit aggregates every 60 s.** The 60 s emission
carries the window's peak / floor / mean, so a 30-second allocation spike is
visible without emitting 60 gauges a minute.

This alone fixes the "instantaneous sample at a random point in the sawtooth"
problem, at zero additional emission cost.

### Principle B — the right metric is platform-specific

|                           | Android                                   | iOS                                                         |
| ------------------------- | ----------------------------------------- | ----------------------------------------------------------- |
| Process model             | Backend in its own `:ComapeoCore` process | Backend on a thread in the app process                      |
| "Backend footprint"       | **`process.memoryUsage().rss`** — exact   | Meaningless (whole app)                                     |
| "What gets us killed"     | lmkd, on the FGS's RSS/PSS                | jetsam, on the _app's_ `phys_footprint`                     |
| Right total-memory metric | Node-side `rss`                           | Native-side `phys_footprint` + `os_proc_available_memory()` |

So `rss` gets emitted **on Android only** (platform-gated inside
`metrics.js`, so call sites stay dumb), and iOS gets an equivalent from Swift.
V8 heap metrics are read Node-side and are meaningful on both.

### 3.1 The sampler

Replace `startMemorySampler()` in `backend/index.js` with a small
`backend/lib/memory-monitor.js` that owns:

```
tick (1 Hz, unref'd):
  const h = v8.getHeapStatistics()          // 0.64 µs — no GC triggered
  const mu = process.memoryUsage()          // Android only; 7 µs
  accumulate: peak/floor/last of used_heap_size, rss, external+arrayBuffers
  if (h.used_heap_size / h.heap_size_limit > NEAR_LIMIT_RATIO) → §3.5

window (60 s):
  emit the aggregates below, reset accumulators
```

`v8.getHeapStatistics()` rather than `process.memoryUsage()` as the primary
read: it is **~10× cheaper** (~0.7 µs vs ~7 µs — `memoryUsage()`'s cost is
dominated by the `/proc` RSS read), and it carries the fields we actually need
(`heap_size_limit`, `total_heap_size`, `number_of_detached_contexts`) that
`memoryUsage()` doesn't have. `memoryUsage()` is still needed on Android for
`rss` and on both platforms for `external`/`arrayBuffers`.

Neither call triggers a garbage collection, so sampling does not perturb what
it measures.

### 3.2 Steady-state metric set (one emission each per 60 s window)

All **Diagnostics** tier — process resource health, no usage shape. All carry
`device_class` + `os_major` in addition to the global `platform`; without them
these numbers can't be correlated with the device population, which is the
whole point.

| Metric                                | Type · unit       | Attrs                                            | Value                               | Why                                                                                                                                                                          |
| ------------------------------------- | ----------------- | ------------------------------------------------ | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `comapeo.backend.heap_used_bytes`     | gauge · byte      | `device_class`, `os_major`                       | window **peak** of `used_heap_size` | _(existing name, redefined from "instantaneous" to "window peak" — note it in ARCHITECTURE.md's catalog)_. The number to compare against a candidate `--max-old-space-size`. |
| `comapeo.backend.heap_floor_bytes`    | gauge · byte      | same                                             | window **min** of `used_heap_size`  | Post-GC live-set floor. A rising floor across a session is the classic leak signature; peak alone can't distinguish leak from churn.                                         |
| `comapeo.backend.heap_limit_ratio`    | gauge · ratio     | same                                             | `peak used / heap_size_limit`       | Headroom. Directly answers "would a smaller limit have OOM'd this device?" — the primary input to §9.                                                                        |
| `comapeo.backend.external_bytes`      | gauge · byte      | same                                             | peak of `external + arrayBuffers`   | Off-heap (sodium, sqlite, hypercore). **Not** bounded by `--max-old-space-size`; if this dominates, old-space tuning is the wrong knob.                                      |
| `comapeo.backend.rss_bytes`           | gauge · byte      | same                                             | peak `rss`                          | **Android only.** Total backend-process footprint = what lmkd scores.                                                                                                        |
| `comapeo.backend.gc_duty_pct`         | gauge · percent   | same                                             | Σ gc pause / window × 100           | The tell-tale for a too-small heap limit: V8 collecting constantly to stay under it.                                                                                         |
| `comapeo.backend.gc_pause_max_ms`     | distribution · ms | `kind` (`minor`/`major`/`incremental`/`weak_cb`) | worst pause in window               | Pairs with `event_loop_delay_ms` to attribute stalls to GC vs handler work.                                                                                                  |
| `comapeo.backend.event_loop_delay_ms` | distribution · ms | _(unchanged)_                                    |                                     | Existing.                                                                                                                                                                    |

That is **8 emissions/min** vs today's 2. Volume analysis in §7.3.

Deliberately _not_ per-window metrics: `gc_count` (derivable from duty +
mean pause, and the count is the noisiest of the three),
`number_of_detached_contexts` (a leak canary but almost always 0 — better as an
attribute on the near-limit event, §3.5), `heapTotal` (`total_heap_size` tracks
`used_heap_size` closely enough that it doesn't earn a slot).

### 3.3 One-shot boot metrics

Emitted once, at `ready`:

| Metric                                  | Type         | Attrs                      | Why                                                                                                                    |
| --------------------------------------- | ------------ | -------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `comapeo.backend.heap_size_limit_bytes` | gauge · byte | `device_class`, `os_major` | **The single most valuable missing number.** What V8 chose by default, per device class. Everything in §9 starts here. |

And the startup profile — sample `used_heap_size` (+ `rss` on Android) at each
existing boot-phase boundary, which `sentry.withSpan()` already brackets:

| Metric                           | Type · unit         | Attrs                               |
| -------------------------------- | ------------------- | ----------------------------------- |
| `comapeo.boot.heap_used_bytes`   | distribution · byte | `phase`, `device_class`, `os_major` |
| `comapeo.boot.rss_bytes`         | distribution · byte | `phase`, … _(Android only)_         |
| `comapeo.boot.memory_peak_bytes` | distribution · byte | `device_class`, `os_major`          |

Phases come free from the existing span names: `loader-init`,
`loader-import-sentry-node`, `import-index`, `manager-init`, plus a synthetic
`ready` marker. Because `withSpan` already records
`comapeo.boot.phase_duration_ms` per phase, adding a memory read at the same
two points is a ~7 µs addition per phase and gives a **memory-vs-time startup
curve keyed to the same phase names as the duration metric** — so a slow phase
and a memory-hungry phase can be read off the same dashboard.

`comapeo.boot.memory_peak_bytes` needs a higher-resolution sampler than the
phase boundaries: run the 1 Hz sampler from the _first line of `loader.mjs`_
rather than from `ready` (it's already unref'd, so it can't hold the process
open), and emit the peak once at `ready`. Cost of the whole startup window at
1 Hz for a ~5 s boot: 5 samples ≈ 35 µs.

### 3.4 GC monitoring

`PerformanceObserver` on `entryTypes: ["gc"]`. Entries carry
`{ duration, detail: { kind, flags } }` — a pause length and a kind, no heap
sizes — so aggregate them in the observer callback into the window
accumulators and never emit per-event.

```js
const obs = new PerformanceObserver((list) => {
  for (const e of list.getEntries()) {
    window.gcTotalMs += e.duration;
    const kind = GC_KIND[e.detail?.kind] ?? "unknown";
    window.gcMaxMs[kind] = Math.max(window.gcMaxMs[kind] ?? 0, e.duration);
  }
});
obs.observe({ entryTypes: ["gc"] });
```

Measured cost: **~30 µs per GC event** in the callback (§7.2). Bounded, and
bounded by the _GC rate_, which is exactly the workload where you want the
data.

One caveat worth stating: `PerformanceObserver` buffers entries between event
loop turns, so a long event-loop stall accumulates entries (~100 bytes each).
At a pathological 100 GC/s and a 10 s stall that's ~100 KB — acceptable, but if
we want a hard bound, cap accumulation and count drops.

**Must be verified on device (§10):** perf_hooks GC entries are core Node, but
nodejs-mobile runs a stripped V8 (jitless on iOS) and its
[documented differences](https://nodejs-mobile.github.io/docs/api/differences/)
already cost us the inspector. If GC entries don't fire, the fallback signal is
`heap_floor_bytes` sawtooth analysis plus `event_loop_delay_ms` — degraded but
not useless — and the whole GC branch is dropped rather than worked around.

### 3.5 Near-limit early warning

A V8 heap-limit OOM calls `FatalProcessOutOfMemory` and aborts. No JS runs, no
Sentry event leaves Node — today we learn about it only from the next launch's
exit record, with no heap composition. So capture _before_ death:

When `used_heap_size / heap_size_limit` crosses **0.85** on a sample tick, emit
once per process (latched, so a device that sits above the threshold doesn't
spam):

- `comapeo.backend.near_heap_limit` — count, attrs `device_class`, `os_major`,
  `ratio_bucket` (`0.85-0.9` / `0.9-0.95` / `0.95+`).
- A Sentry **event** (message, `warning`) carrying the full
  `v8.getHeapStatistics()` **and** `v8.getHeapSpaceStatistics()` in a
  `node_heap` context — per-space breakdown (`old_space`, `new_space`,
  `code_space`, `large_object_space`) is what tells you _which_ space is
  filling. `getHeapSpaceStatistics()` costs 2.14 µs and runs at most once per
  process, so its cost is irrelevant.

None of this carries user data: sizes and space names only.

Optionally, under the existing 72 h `debug` toggle only, add
`--heapsnapshot-near-heap-limit=1` to argv so an investigation build writes a
real snapshot. **Not** for production — the snapshot is heap-sized (hundreds of
MB), writes to disk, and takes seconds.

### 3.6 Native-side memory (the numbers Node can't see)

**iOS** — the two numbers that actually predict a jetsam kill:

- `os_proc_available_memory()` (`<os/proc.h>`, iOS 13+) — bytes remaining
  before this app is killed. There is no better single number on iOS.
- `task_info(TASK_VM_INFO)` → `phys_footprint` — the quantity jetsam scores.

Sample both on the existing native metric cadence and emit
`comapeo.app.footprint_bytes` and `comapeo.app.available_memory_bytes`
(gauge · byte, `proc=main`). Plus subscribe a
`DispatchSource.makeMemoryPressureSource(eventMask: [.warning, .critical])` and
emit `comapeo.app.memory_pressure` (count, attr `level`).

**Android** — `onTrimMemory` in both the main process and the FGS:
`comapeo.app.trim_memory` (count, attrs `level`
(`running_moderate`/`running_low`/`running_critical`/`ui_hidden`/`background`/`complete`),
`proc` (`main`/`fgs`)). This is the direct lmkd-pressure precursor and costs
nothing — it's a callback we already could receive and currently ignore.

Deliberately **not** used on Android: `Debug.getMemoryInfo()` /
`ActivityManager.getProcessMemoryInfo()`. Both walk `/proc/<pid>/smaps` and
cost tens of milliseconds; Node-side `rss` gives us the FGS footprint for
~7 µs. `Debug.getNativeHeapAllocatedSize()` is cheap but measures the JVM
process's native heap, which for the FGS is largely libnode itself — low value
next to `rss`.

### 3.7 Sampling cadence

| Window                 | Sample                  | Emit                                 |
| ---------------------- | ----------------------- | ------------------------------------ |
| loader start → `ready` | 1 Hz + phase boundaries | once at `ready` (boot metrics, §3.3) |
| `ready` → +60 s        | 1 Hz                    | every **10 s** (6 windows)           |
| steady state           | 1 Hz                    | every **60 s**                       |

The 10 s granularity for the first minute is what resolves "memory right after
startup" — the settling curve as caches warm and the first sync runs — without
paying 6× volume for the whole session. After 60 s it collapses to the current
cadence.

On iOS the runtime suspends in the background, so windows are wall-clock-uneven
there; the aggregates are per-window, not per-second rates, so this degrades
gracefully (a suspended window simply reports fewer samples). Worth carrying a
`samples` attribute? No — it would double the cardinality for a caveat better
documented once.

---

## 4. Where the code goes

| File                                                                                                               | Change                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend/lib/memory-monitor.js` _(new)_                                                                            | Sampler, window accumulators, GC observer, near-limit latch. Pure logic + injected clock/timer so it unit-tests without a real 60 s wait.            |
| `backend/lib/memory-monitor.test.mjs` _(new)_                                                                      | Node test-runner suite, matching the existing `*.test.mjs` convention.                                                                               |
| `backend/lib/metrics.js`                                                                                           | New emitters (§3.2/§3.3); platform-gate `rss_bytes` inside `metrics.js` (config already has `platformTag`); add `deviceTags()` to the memory gauges. |
| `backend/index.js`                                                                                                 | Replace `startMemorySampler()` with the monitor's `start()`; emit boot memory at `ready`.                                                            |
| `backend/loader.mjs`                                                                                               | Start the sampler at first line so startup is covered.                                                                                               |
| `backend/lib/sentry.js`                                                                                            | `withSpan()` records a memory sample alongside `recordPhase()`.                                                                                      |
| `ios/*.swift`                                                                                                      | `phys_footprint` / `os_proc_available_memory` sampler + memory-pressure source.                                                                      |
| `android/.../ComapeoCoreService.kt`, main-process listener                                                         | `onTrimMemory` → `comapeo.app.trim_memory`.                                                                                                          |
| `ios/SentryMetricScrub.swift`, `android/.../SentryMetricScrub.kt`, `backend/before-send.js`, `src/sentry-scrub.ts` | No change expected — no new forbidden attrs — but the four-file lock-step rule applies if any attr is added.                                         |
| `docs/ARCHITECTURE.md`                                                                                             | Extend the metric catalog (§ "Metrics"); note the `heap_used_bytes` redefinition.                                                                    |
| `docs/sentry-integration.md`                                                                                       | Add the new rows to the §9.2 tier table; fix the stale §7.3.8 row (§1.5).                                                                            |

---

## 5. Tests

- **Unit** (`backend/lib/memory-monitor.test.mjs`): injected fake
  `getHeapStatistics`/`memoryUsage`/timer; assert peak/floor/ratio maths,
  window reset, near-limit latching (fires once, not per tick), GC
  accumulation, the Android-only `rss` gate, and the no-op path when Sentry is
  off.
- **Unit** (`backend/lib/metrics.test.mjs`): extend the existing emitted-names
  assertion (currently `["comapeo.backend.heap_used_bytes"]`) to the new set.
- **Native**: extend `SentryMetricScrubTests.swift` / `SentryMetricScrubTest.kt`
  for the new attr names; an XCTest for `AppExitMetricsCollector`'s sibling
  footprint sampler.
- **On-device**: an `apps/integration` screen that dumps
  `v8.getHeapStatistics()`, `getHeapSpaceStatistics()`, `heap_size_limit`, and
  GC-observer liveness — this is how §10's open questions get answered, and it
  doubles as the overhead-measurement harness (§7.4).

---

## 6. Rollout

The metrics are diagnostics-tier and always-on, so there is no toggle to hide
behind. Mitigation is ordering: land §8's phases 1–2 (cheap, high-value, no new
mechanisms) and read a week of real data before adding the GC observer, which
is the only piece with a non-trivial per-event cost and an unverified
nodejs-mobile dependency.

---

## 7. Overhead

Measured with `node scripts/bench/memory-overhead.mjs` on `node v22.22.2 / x64`
— 20 000 iterations after a 2 000-iteration warm-up, median of interleaved
trials. Re-run it to reproduce, or through `apps/integration` to get the
on-device numbers (§7.4).

### 7.1 Per-call cost of the sampling APIs

| Call                          | Cost         | Notes                                                 |
| ----------------------------- | ------------ | ----------------------------------------------------- |
| `v8.getHeapStatistics()`      | **~0.7 µs**  | Reads V8 counters. No GC triggered. The primary read. |
| `v8.getHeapSpaceStatistics()` | **~2.2 µs**  | Per-space breakdown. Near-limit event only.           |
| `process.memoryUsage()`       | **~7 µs**    | Cost is the `/proc` RSS read, not the heap part.      |
| `process.memoryUsage.rss()`   | **~5 µs**    | RSS only.                                             |
| `os.freemem()`                | **~6 µs**    | Already used, event-processor path only.              |
| `process.constrainedMemory()` | **~16 µs**   | cgroup read; unverified on Android (§10).             |
| `process.uptime()`            | **~0.15 µs** |                                                       |
| `eld.max` + `eld.reset()`     | **~12 µs**   | Existing, once per 60 s.                              |

(Two independent runs agreed within ~10 % on every row.)

**Per-tick cost at 1 Hz:** `getHeapStatistics()` + `memoryUsage()` ≈ **~8 µs**
on Android, **0.64 µs** on iOS (no `rss` read) — call it ~8 µs/s, i.e.
**0.0008 % of one core**. Even at a pessimistic 5× penalty for arm64 / Node 18
/ iOS's jitless V8, that's ~40 µs/s ≈ **0.004 %**. It is not a measurable
battery or CPU cost; it is not worth trading fidelity to reduce.

Startup adds ~5 samples plus ~5 phase reads ≈ **70 µs** for the whole boot.

### 7.2 GC `PerformanceObserver` overhead

Measured with an allocation-heavy synthetic workload (40 000 short-lived
objects per event-loop turn, ~119 GC/s — far above anything this backend does),
interleaved A/B/C × 10:

| Configuration                                   | Run A                 | Run B                 |
| ----------------------------------------------- | --------------------- | --------------------- |
| no observer                                     | 678.4 ms              | 635.2 ms              |
| gc observer                                     | 694.2 ms (**+2.3 %**) | 643.6 ms (**+1.3 %**) |
| gc observer + `process.memoryUsage()` per event | 690.7 ms (**+1.8 %**) | 664.4 ms (**+4.6 %**) |

The wall-clock delta is close to the noise floor — the two observer variants
swap order between runs — so read it as **1–5 % under a ~120 GC/s pathological
load** rather than a point estimate. Direct instrumentation of the callback
gives the figure that actually scales, and it is stable across runs:
**27–30 µs per GC event**, over ~1 650 events each.

So the honest way to state it: **GC monitoring costs ~30 µs per garbage
collection.**

| Realistic GC rate                | Overhead               |
| -------------------------------- | ---------------------- |
| 1 GC/s (idle backend)            | 27 µs/s — **0.003 %**  |
| 5 GC/s                           | 136 µs/s — **0.014 %** |
| 20 GC/s (active sync)            | 0.5 ms/s — **0.05 %**  |
| ~120 GC/s (synthetic worst case) | 1–5 %                  |

The overhead is self-limiting in the wrong direction only in the case we most
want to observe (heavy GC), and even then it is ~2 %.

### 7.3 Sentry volume — the real cost

CPU is free; emissions are billed.

|                        | Today  | Proposed                       |
| ---------------------- | ------ | ------------------------------ |
| Steady state           | 2 /min | 8 /min                         |
| First 60 s after ready | —      | 8 × 6 = 48 (one-off)           |
| Boot one-shots         | 0      | ~1 + 3 × phases ≈ 13 (one-off) |
| Per 1 h session        | ~120   | ~540                           |

Per 10 000 daily devices at 1 h/day: **1.2 M → 5.4 M metric items/day**. That
is the number to sanity-check against the Sentry plan before landing, and the
one real reason to trim. Levers, in order of preference:

1. Drop the 10 s startup window to 3 windows (10 s/30 s/60 s) → −24/session.
2. Drop `gc_pause_max_ms`'s `kind` attribute (attributes don't multiply
   billing, but 4 kinds means up to 4 emissions where a single one would do)
   → up to −3/min.
3. Move the steady-state window to 120 s once the startup question is answered
   → halves the dominant term.

Lever 3 is the right long-term setting: once `--max-old-space-size` is chosen,
steady-state memory becomes a regression watch, not an investigation, and 2 min
resolution is plenty.

### 7.4 Verifying the overhead on device

The numbers above are x64 / Node 22 / JIT. The device is arm64 / Node 18.20.4 /
nodejs-mobile, and **iOS runs V8 jitless**, where interpreted JS glue is
several times slower (the native syscall portion of `memoryUsage()` is not).
Before the GC observer lands, re-run the same two benchmark scripts through the
`apps/integration` app on one low-end Android device and one iOS device and
record the real numbers here. Everything in §7.1 is so far below the noise
floor that only §7.2 genuinely needs on-device confirmation.

### 7.5 Overhead that isn't CPU

- **Memory of the monitor itself**: accumulators are a handful of numbers; the
  `monitorEventLoopDelay` HDR histogram already exists; GC entries are transient
  (§3.4). Under a kilobyte steady-state.
- **Measurement does not perturb**: none of `getHeapStatistics`,
  `getHeapSpaceStatistics` or `memoryUsage` triggers a collection, so sampling
  can't distort the heap numbers or add GC pauses.
- **Wakeups**: 1 Hz `setInterval` in a process that already runs an
  event-loop-delay monitor at 10 ms resolution. On iOS the timer freezes with
  the runtime when the app suspends, so it costs nothing in the background. On
  Android the FGS is awake anyway (that's the point of the FGS). Negligible —
  but if it ever shows up in battery numbers, drop the sampler to 0.2 Hz in
  steady state and keep 1 Hz only for the first 60 s.

---

## 8. Implementation order

Each phase is independently landable and independently useful.

**Phase 1 — the cheap facts (highest value/effort ratio).**
`heap_size_limit_bytes` one-shot; add `device_class`/`os_major` to the existing
heap gauge; add `external_bytes`; add `rss_bytes` on Android. No new mechanism,
no new timer, ~4 lines in `metrics.js` and one call site. **This alone tells us
what V8's default limit is on real devices, which is the prerequisite for
choosing `--max-old-space-size` at all.**

**Phase 2 — the sampler and the startup profile.**
`memory-monitor.js` with 1 Hz sampling and windowed peak/floor/ratio; start it
from `loader.mjs`; boot-phase memory in `withSpan`; `boot.memory_peak_bytes`;
the 10 s startup windows.

**Phase 3 — near-limit warning.** Latched threshold event with the heap-space
breakdown. Small, and it's the only thing that gives us a pre-mortem.

**Phase 4 — GC.** The observer, `gc_duty_pct`, `gc_pause_max_ms`. Gated on the
nodejs-mobile verification in §10.

**Phase 5 — native memory.** iOS footprint + available memory + pressure
source; Android `onTrimMemory`. Independent of 1–4; can run in parallel.

**Phase 6 — act on the data.** Plumb `--max-old-space-size` (and possibly
`--max-semi-space-size`) through argv, per §9.

---

## 9. Using the data to choose `--max-old-space-size`

The point of all of the above. Once phases 1–4 have a week of fleet data:

1. **Read `heap_size_limit_bytes` by `device_class`.** This is what V8 picked
   from physical memory. Expect it to be far above anything reachable — the OS
   kills first. Confirms the limit is currently doing nothing.
2. **Read p99 of `heap_used_bytes` (window peak) by `device_class`.** The
   candidate limit must sit above this or you convert "occasionally slow" into
   "hard crash". A V8 heap-limit OOM is an `abort()` — strictly worse than the
   lmkd/jetsam kill it's meant to pre-empt, because it takes the process down
   _deterministically_ at the p99 workload.
3. **Read `heap_floor_bytes` p99.** The live set. The floor is the hard
   constraint; the gap between floor and peak is collectable garbage, which a
   lower limit will simply force V8 to collect more often.
4. **Read `external_bytes`.** If off-heap dominates the footprint,
   `--max-old-space-size` is the wrong knob and the work belongs in
   sodium/sqlite buffer lifetimes instead. Decide this before tuning.
5. **Set the candidate limit**, then watch `gc_duty_pct` and
   `event_loop_delay_ms`. Rising GC duty at the new limit means it's too tight;
   the cost shows up as jank and battery long before it shows up as a crash.
6. **Confirm against `heap_limit_ratio` and the exit metrics** — the intended
   outcome is fewer `exit_reason=low_memory` (Android) /
   `memory_resource_limit` (iOS) records, _without_ a rise in backend aborts.

Two platform notes that fall out of §1.4:

- **iOS**: the jetsam limit is app-wide. The backend's old-space budget has to
  leave room for React Native, Hermes, the map renderer and image caches — so
  the iOS value should be materially lower than the Android one, where the
  backend owns its process. This is an argument for a **per-platform** flag
  value, not one shared constant.
- **Android**: bounding V8 keeps the FGS's RSS low enough that lmkd deprioritises
  killing it. `--max-semi-space-size` is worth a look too — a larger young
  generation trades RSS for fewer scavenges, and on a GC-heavy sync workload
  that trade may be the better one. `gc_duty_pct` split by GC kind is the
  measurement that decides it.

Plumbing: insert the flags into argv **before the script path** in
`ios/NodeJSService.swift`'s `args` array and Android's `buildBackendArgs()`,
next to the existing `--no-experimental-fetch`. Consider exposing the value
through the Expo config plugin so consuming apps can tune it per-device-class
without a module release.

---

## 10. Open questions — verify on device before building on them

nodejs-mobile is **Node 18.20.4** with a stripped V8 (jitless on iOS), so
Node-22-documented behaviour cannot be assumed. Each of these is a one-line
check in the `apps/integration` harness (§5):

1. **`v8.getHeapStatistics()` field set on 18.20.4.** `external_memory` is a
   later addition; `total_global_handles_size` / `used_global_handles_size` may
   or may not be present. Log `Object.keys(v8.getHeapStatistics())` on device
   and design against what's actually there. The plan above only _requires_
   `used_heap_size` and `heap_size_limit`, which are ancient — but
   `external_bytes` should come from `process.memoryUsage().external +
.arrayBuffers` rather than `getHeapStatistics().external_memory` for exactly
   this reason.
2. **Do perf_hooks GC entries fire under nodejs-mobile?** If not, phase 4 is
   dropped, not worked around (§3.4).
3. **Does `process.constrainedMemory()` return non-zero on Android?** If it
   reports the app's cgroup limit it's a better "how much can we actually use"
   number than `os.totalmem()`; at 15 µs it's still cheap enough for a one-shot
   read at boot. Likely returns 0 on iOS.
4. **What is `heap_size_limit` per device class, actually?** The premise of §9
   is that it's far above reachable memory. Phase 1 exists to check that premise
   rather than assume it.
5. **Does `--max-old-space-size` in argv take effect at all** under
   nodejs-mobile's embedded start path? Verify by setting a deliberately tiny
   value in a debug build and confirming `heap_size_limit` moves.
