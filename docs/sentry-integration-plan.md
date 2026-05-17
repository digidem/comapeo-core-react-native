# Sentry Integration — Remaining Work

What's still ahead in the Sentry integration. Companion docs:

- [`sentry-integration.md`](./sentry-integration.md) — architecture as it
  stands today.
- [`sentry-integration-history.md`](./sentry-integration-history.md) —
  per-phase record of work that's already landed.

The numbering below follows the original phase scheme so cross-references in
git history stay valid.

## Status snapshot

| Phase                                                                      | Notes                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 4 — `@comapeo/core` OTel forwarding                                  | Blocked on `@comapeo/core` PR #1051 landing. Verification work only.                                                                                                                                                                                                                           |
| Phase 5 — capture-application-data opt-in surface                          | Per-RPC method spans, sync session transaction, bg/fg breadcrumbs, memory checkpoints, storage size sample, and the `before_send` privacy processor. The toggle plumbing itself is already done in Phase 9a.                                                                                  |
| Phase 6 — Android historical exit reasons                                  | Surface `ApplicationExitInfo` records on next start; isolates OEM-killer FGS deaths, LMK background kills, and "alive-for / backgrounded-for" durations per device. API 30+ only.                                                                                                              |
| Phase 7 — iOS app-exit telemetry                                           | Subscribe to `MXMetricPayload` and forward `MXAppExitMetric` buckets (memory-pressure, background-task-assertion-timeout, watchdog, etc.) as Sentry events. 24h-aggregate resolution. iOS 14+. Optional 7b sub-phase adds a `UserDefaults`-anchored "killed-in-background" heuristic.          |
| Phase 8 — refinements                                                      | Sample-rate tuning from real data; optional dual-bundle if size matters.                                                                                                                                                                                                                       |
| Phase 9b — PII scrubber, user.id rotation, context reclassification        | Substring scrubber; installation UUID with monthly hash at diagnostic tier; native-scope field split; consoleIntegration gating; network-URL scrubbing.                                                                                                                                       |
| Phase 11 — Metrics-first observability + `debug` tier                      | Shift day-to-day performance signal from per-RPC tracing to Sentry metrics (with bucketed device tags so "Samsung A52 is slow at sync" is a dashboard query). Rename `captureApplicationData` → `applicationUsageData` (now: stable `user.id` + usage events). New user-facing `debug` toggle enables per-RPC tracing for investigation. |

---

## Phase 4 — `@comapeo/core` OpenTelemetry forwarding

- Bump `@comapeo/core` once PR #1051 lands.
- Verify Sentry's OTel integration picks up the spans with the RPC
  transaction as parent.
- Document any required tracing-config overrides.

Value: deep traces inside core operations (sync, indexing, hypercore) — the
data Sentry's performance tab is designed to surface.

---

## Phase 5 — capture-application-data opt-in surface

The toggle infrastructure (prefs store, JS API, native readers, argv
plumbing) already shipped in Phase 9a. What's still pending is the
**captures the toggle gates**:

- **Per-RPC client + server spans.** `tracesSampleRate` effectively goes
  from 0 → its configured value (default 0.1). Method names only; never
  args. Span attributes include `rpc.method`, `rpc.status`,
  `rpc.duration_ms`.
- **Sync session lifecycle transaction.** A `comapeo.sync.session`
  transaction from `connectPeers` (or first peer-connected event) through
  to `syncFinished`/`disconnect`. Spans inside for `discover`, `handshake`,
  `replicate`. Counts only: number of peers (bucketed), bytes transferred
  (bucketed), duration. **No peer identities, no project IDs in raw form.**
- **Background/foreground transitions** — host-app `pause` and `resume`
  events become `comapeo.app.background` / `comapeo.app.foreground`
  breadcrumbs that ride on subsequent events, helping correlate timing
  ("error fired 3s after app backgrounded").
- **Backend memory checkpoint.** Once at `STARTED` and every 60s
  thereafter, a custom context entry on the next event with
  `process.memoryUsage()` snapshot (rss, heapTotal, heapUsed). No event
  capture by itself — context only.
- **`privateStorageDir` size sample.** Once at `STARTED`, the on-disk size
  of dbFolder + indexFolder + customMaps as a numeric `du`-style integer.
  Bucketed (`<10MB`, `10–100MB`, `100MB–1GB`, `>1GB`) before sending to
  avoid leaking the exact size of a sensitive dataset.
- **`before_send` privacy processor** — see Phase 9b for the full design;
  Phase 5 lands the wiring in `backend/before-send.js` so the captures
  above are scrubbed before they leave Node.

Cost: ~150 LOC native + JS + backend.

---

## Phase 6 — Android historical exit reasons

Surface `ActivityManager.getHistoricalProcessExitReasons()` records to
Sentry on the next process start. The goal is observability on two
questions that nothing else in the integration answers:

1. **How long is the app in the background before the system kills it?**
   Aggregable by `Build.MANUFACTURER` / `Build.MODEL` so we can see
   "Samsung A52 reliably kills our cold backend after ~12 min
   backgrounded" type signals.
2. **Is an OEM custom killer reaching past Android's FGS protection and
   shooting our `:ComapeoCore` process?** Aggressive OEM killers (MIUI,
   EMUI, OxygenOS, OneUI, etc.) bypass AOSP LMK and send SIGKILL to
   foreground services; they show up as `REASON_SIGNALED` +
   `processStateAtExit = IMPORTANCE_FOREGROUND_SERVICE`, which is the
   smoking gun.

### 6.1 Scope and platform availability

- **Android only.** iOS doesn't expose process-death post-mortems.
- **API 30+ (Android 11) only** for the exit-reason data. Pre-30 devices
  emit one boot-time tag `exitReasons.supported=false` so the dashboard
  can exclude them from death-rate math; nothing else is collected.
- Two callers: the main UI process (`MainApplication.onCreate` via an
  `ApplicationLifecycleListener` from `expo-modules-core`) and the FGS
  process (`ComapeoCoreService.onCreate`). Each reports the exits for
  _its own_ process name only — the AOSP API returns all package
  processes when called without filters, but reporting duplicates from
  both callers makes Sentry-side dedup harder than filtering
  client-side.

### 6.2 New files

- `android/src/main/java/com/comapeo/core/ExitReasonsCollector.kt` —
  pure-logic decoder + emission. Single entry point
  `collectAndReport(context, processName)` that:
  1. No-ops on `Build.VERSION.SDK_INT < 30` after setting the
     supported=false scope tag once.
  2. Calls
     `ActivityManager.getHistoricalProcessExitReasons(packageName, pid=0, maxNum=10)`.
     `maxNum=10` is enough — anything older than the last 10 cold starts
     isn't useful.
  3. Filters records: `processName` match AND `timestamp > lastSeenAtMs`
     (read from prefs; see below).
  4. For each kept record, emits a Sentry event via
     `SentryFgsBridge.captureMessage` (FGS-side) or `Sentry.captureMessage`
     directly (main-side).
  5. Writes the new high-water `lastSeenAtMs` back to prefs atomically
     (one `apply()` per process name).
- `android/src/main/java/com/comapeo/core/BackgroundAnchors.kt` — thin
  `SharedPreferences` wrapper holding two slots per process name:
  `<proc>.backgrounded_at_wall_ms` and `<proc>.process_started_at_wall_ms`.
  Wall-clock (`System.currentTimeMillis()`) so values survive reboots and
  cross-process reads. Stored under the same prefs file the Phase 5
  capture-application-data toggle uses
  (`com.comapeo.core.prefs`).
- `android/src/main/java/com/comapeo/core/ExitReasonTags.kt` — enum
  decode helpers. Plain `when` blocks; one for `reason`, one for
  `processStateAtExit`. Kept in a separate file so the unit test can
  exercise them without instantiating `ApplicationExitInfo` (which can't
  be constructed off-device).

### 6.3 Anchor write sites

Wall-clock stamps written to `BackgroundAnchors`:

- **`process_started_at_wall_ms` (main)**: in the main `Application.onCreate`
  or earlier — the `ApplicationLifecycleListener` from `expo-modules-core`
  runs late enough but is still fine for "process alive duration" at
  second-resolution.
- **`process_started_at_wall_ms` (fgs)**: in `ComapeoCoreService.onCreate`,
  alongside the existing Sentry init. (Don't reuse `serviceStartElapsedMs` —
  that's `elapsedRealtime`, monotonic but not durable across process
  death.)
- **`backgrounded_at_wall_ms` (main)**: observe
  `ProcessLifecycleOwner.get().lifecycle` for `ON_STOP`; stamp there.
  Clear (set to `0`) on `ON_START` so derived "backgrounded for X" only
  counts when the death actually happened during background. The listener
  registration belongs in the main `ApplicationLifecycleListener`, not in
  `ComapeoCoreReactActivityLifecycleListener` (which is per-Activity —
  `ProcessLifecycleOwner` is the cleaner anchor and fires once per
  whole-process transition).
- **`backgrounded_at_wall_ms` (fgs)**: skip. The FGS doesn't have a
  foreground/background concept; "alive for" against `process_started_at`
  is the right derived field for FGS deaths.

### 6.4 High-water timestamp persistence

`lastSeenAtMs` is per-process-name (`main.exit_reasons.last_seen_ms` /
`fgs.exit_reasons.last_seen_ms`) so the two callers don't race each other
on a shared key. The high-water value is the max
`ApplicationExitInfo.getTimestamp()` of the records reported in the
current run. First run on a fresh install: `lastSeenAtMs = 0` means we'd
report every record in the buffer; that's noise. Defend against it by
initialising `lastSeenAtMs` to `currentTimeMillis()` on first observation
(when the prefs key is absent), so we only report exits that happen
_after_ the first time the collector ran. Trade-off: we'll miss the very
first cohort of exits right after installing the feature, but in exchange
we don't flood Sentry with the pre-feature backlog on every device's
first update.

### 6.5 Sentry emission shape

One `captureMessage` per kept record. Message text:
`"android exit: <REASON_NAME>"` (e.g. `"android exit: REASON_SIGNALED"`).
Stable string so Sentry's grouping treats them as one issue per reason,
sliceable by tags.

| Tag                                | Source                                                                                                        | Notes                                                                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `proc`                             | `main` / `fgs`                                                                                                | Already in `SentryTags`.                                                                                                                                       |
| `exit.reason`                      | decoded `REASON_*` (lowercase, no prefix)                                                                     | e.g. `low_memory`, `signaled`, `excessive_resource_usage`.                                                                                                     |
| `exit.process_state`               | decoded `IMPORTANCE_*`                                                                                        | e.g. `cached`, `foreground_service`.                                                                                                                           |
| `exit.signal`                      | signal number (when `reason=signaled`)                                                                        | String. SIGKILL = `"9"`.                                                                                                                                       |
| `exit.intentional`                 | `true` for `USER_REQUESTED` / `USER_STOPPED` / `EXIT_SELF`; `false` otherwise                                 | Lets dashboards exclude the "user / app did this on purpose" cohort from kill-rate metrics.                                                                    |
| `oem.killer.suspected`             | `true` when `reason=signaled` ∧ `process_state ∈ {foreground, foreground_service}` ∧ `signal=9`               | The headline tag for the OEM-aggressive-killer cohort. Pair with `Build.MANUFACTURER` / `Build.MODEL` in dashboard queries.                                    |
| `comapeo.fgs.killed_in_background` | `true` when `proc=fgs` ∧ a non-zero `main.backgrounded_at_wall_ms` was captured before the FGS exit timestamp | "FGS died while the user wasn't looking" — the cohort battery-optimization analysis cares about.                                                               |
| `bg_duration_bucket`               | `<1m` · `1-5m` · `5-15m` · `15-60m` · `1-6h` · `>6h` · `unknown`                                              | Coarse bucket of `backgrounded_for_ms`. String tags are reliably aggregable in Discover; numeric `extra` fields aren't. `unknown` when the anchor was 0/null. |
| `uptime_bucket`                    | `<10s` · `10-60s` · `1-5m` · `5-30m` · `30m-2h` · `>2h` · `unknown`                                           | Coarse bucket of `alive_for_ms`. Different range than `bg_duration_bucket` because process uptime distributes differently.                                     |

| Extra field           | Value                                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `description`         | `ApplicationExitInfo.description` (vendor string when present; Samsung/Xiaomi sometimes name their killer here).                                                                                  |
| `pss_kb` / `rss_kb`   | Memory at kill.                                                                                                                                                                                   |
| `exit_timestamp_ms`   | Raw wall-clock.                                                                                                                                                                                   |
| `alive_for_ms`        | `exit_timestamp − process_started_at_wall_ms`. Null when the anchor wasn't set. Exact value, for per-record drill-down. The coarse cohort axis is `uptime_bucket` (above).                        |
| `backgrounded_for_ms` | `exit_timestamp − backgrounded_at_wall_ms`. Main-process only; null for FGS or when anchor was 0. Exact value, for per-record drill-down. The coarse cohort axis is `bg_duration_bucket` (above). |

#### 6.5.1 Why duration buckets are tags, not metrics

The two duration fields are the most product-relevant numbers in this
phase, and they need to be slice-aggregable in dashboards ("p50
backgrounded-for-ms on Xiaomi Mi 11"). The natural primitive for that
would be Sentry's metrics product (counters / distributions / gauges),
but as of October 2024 Sentry sunset the standalone metrics beta and
`Sentry.setMeasurement()` is also deprecated — the recommended
replacement is span attributes, which require a live trace context that
our cold-start post-mortem reads don't have. Building a synthetic span
just to attach two numeric attributes is more ceremony than the data
warrants given the volume (≤ a handful of records per cold start, single
digits per session per user).

So events are the right primitive. To preserve dashboard slicability,
every numeric duration is emitted **twice**: exact value as a numeric
`extra` (drill-down precision) AND coarse pre-bucketed string tag
(group-by cohort in Discover). Discover's `count(*)` over a tag bucket
gives us the actionable answer ("65% of OnePlus FGS kills happen 5-15
min into background") without paying for true percentile aggregation
infrastructure on a low-volume signal.

Level mapping:

| Reason                                                                                                             | Level                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `LOW_MEMORY` · `SIGNALED` · `EXCESSIVE_RESOURCE_USAGE` · `DEPENDENCY_DIED`                                         | `error`                                                                                                                                                            |
| `ANR` · `CRASH` · `CRASH_NATIVE` · `INITIALIZATION_FAILURE`                                                        | `warning` (Sentry already captures the crash itself via `sentry-android` — this is just the matching post-mortem record so the two events can be cross-referenced) |
| `USER_REQUESTED` · `USER_STOPPED` · `EXIT_SELF` · `PACKAGE_STATE_CHANGE` · `PACKAGE_UPDATED` · `PERMISSION_CHANGE` | `info`                                                                                                                                                             |
| Anything else (incl. `OTHER`)                                                                                      | `info`                                                                                                                                                             |

Breadcrumb category: `comapeo.exit` (add to `SentryCategories`).

### 6.6 Wiring

- Main process: register an `ApplicationLifecycleListener` from this
  module's `expo-module.config.json`. In `onCreate(Application)`,
  schedule `ExitReasonsCollector.collectAndReport(context, mainProcessName)`
  on a background `Handler` (or `lifecycleScope.launch(Dispatchers.IO)`)
  so the prefs read + Sentry capture doesn't block app start.
- FGS process: call from `ComapeoCoreService.onCreate` _after_
  `SentryFgsBridge.init(...)` succeeds, on
  `serviceScope.launch(Dispatchers.IO)`. Pass the FGS process name
  (`packageName + ":ComapeoCore"`).
- Both call sites must use the same `BackgroundAnchors` instance
  semantics — the prefs file is shared. The collector takes the
  process-name argument explicitly rather than reading
  `Process.myProcessName()` so the test can exercise both code paths
  without spinning up two processes.

### 6.7 Why semantic separation matters

`REASON_USER_STOPPED` and `REASON_USER_REQUESTED` are the user actively
killing the app (Settings → Force stop, task-killer apps, OS update
flows). They are arithmetically valid data points — `backgrounded_for_ms`
and `alive_for_ms` derive correctly — but they have a different
_meaning_ from system-driven kills. Lumping them into the same dashboard
cohort as `LOW_MEMORY` / `SIGNALED` would inflate the "battery-optimization
killed us" metric every time an annoyed user force-stopped the app. The
`exit.intentional` tag lets the OEM-killer dashboard query
`exit.intentional:false oem.killer.suspected:true` and exclude the noise
without losing the records.

### 6.8 Caveats that affect the implementation

- `getHistoricalProcessExitReasons(packageName, pid=0, maxNum=0)` with
  `maxNum=0` (= unlimited) is documented as slow on some devices. Use
  `maxNum=10`.
- Some OEM killers (older MIUI, Huawei EMUI) kill via `init`-level paths
  that don't leave a clean `ApplicationExitInfo` record at all.
  Best-effort — coverage isn't 100%. Document this in the feature notes
  so dashboard math accounts for "missing" deaths on certain vendors.
- `getHistoricalProcessExitReasons` records persist across reboots on
  most ROMs but not all (some clear them on boot). The high-water
  timestamp handles this correctly — we just won't see records older
  than the last surviving entry.
- `description` and the tombstone via `traceInputStream()` can contain
  process-internal memory addresses. Don't capture `traceInputStream()`
  (it's a stream of bytes that could exceed Sentry's event size limit
  and contain user-context strings on some vendors); `description` is a
  short label and is safe to forward as-is.
- `ProcessLifecycleOwner` requires
  `androidx.lifecycle:lifecycle-process` — check whether it's already on
  the runtime classpath via React Native's transitive deps. If not, add
  a thin compile dep matching the version expo brings in.
- The FGS process gets its own `ProcessLifecycleOwner` instance but the
  lifecycle events fired there reflect FGS activities only (none in our
  case), so the FGS-side `backgrounded_at` slot stays unused. That's
  intentional — the `comapeo.fgs.killed_in_background` derivation reads
  the _main_-side anchor.

### 6.9 Tests

- `ExitReasonsCollectorTest.kt` (JVM unit test): inject a fake
  `getHistoricalProcessExitReasons` source returning hand-built records
  (use small data classes mirroring the `ApplicationExitInfo` fields you
  care about, since the real class can't be instantiated off-device).
  Cover:
  - First-run no-op: prefs unset → records seen this run set
    `lastSeenAtMs` but emit nothing.
  - Subsequent run: only records newer than `lastSeenAtMs` are emitted;
    tag/extra/level mapping is correct.
  - OEM-killer detection: `signaled` + `foreground_service` + signal 9
    sets `oem.killer.suspected=true`.
  - Intentional exits: `user_stopped` sets `exit.intentional=true` and
    level `info`, regardless of process state.
  - Derived fields null-safe when anchors absent.
  - Duration buckets: every boundary case (1 ms below, 1 ms above,
    exactly on the edge) lands in the expected bucket for both
    `bg_duration_bucket` and `uptime_bucket`; null anchors produce
    `unknown`.
- `ExitReasonTagsTest.kt`: decode-table coverage (every enum value the
  AOSP javadoc lists, plus a fallthrough for unknown ints — newer API
  levels can add reasons, and we want `unknown:<int>` rather than a
  crash).

### 6.10 Out of scope for Phase 6

- Job/alarm restriction telemetry (the _other_ half of OEM aggression —
  they don't kill, they just stop dispatching background work). Would
  require `JobScheduler`/`WorkManager` observation. File as a future
  phase if it becomes a question.
- iOS app-exit telemetry. Covered separately in Phase 7 — the iOS model
  (`MXAppExitMetric` in MetricKit, 24h aggregates) is different enough
  that combining it with the Android per-event post-mortem in a single
  phase is the wrong unit of work.
- Histogram / metrics-product emission. Initially keep it as events
  keyed on tags; if event volume becomes a problem or histograms become
  useful, layer `Sentry.metrics.distribution` on top later.

Value: actionable visibility into the single most user-impacting class
of failure on Android (silent FGS kill in background), and the first
quantitative answer to "which OEMs kill our process hardest".

Cost: ~250 LOC Kotlin + ~150 LOC tests. No JS/iOS/backend changes.

---

## Phase 7 — iOS app-exit telemetry

iOS counterpart to Phase 6. Provides observability on _which Apple-driven
termination buckets the app falls into_ and how often, derived from
MetricKit's `MXAppExitMetric`. The shape is different enough from Phase 6
that the two are not unified.

### 7.1 Why this is our implementation, not Sentry's

Verified against current Sentry docs and the canonical sentry-cocoa
MetricKit issue:

- Sentry-cocoa's `SentryMetricKitIntegration` subscribes to
  `MXHangDiagnostic`, `MXDiskWriteExceptionDiagnostic`, and
  `MXCPUExceptionDiagnostic` — the _diagnostic_ side of MetricKit
  (per-event records). These three reach the consumer's Sentry hub for
  free via `@sentry/react-native`'s bundled sentry-cocoa.
- Sentry-cocoa **does not subscribe to `MXMetricPayload`** — the _metric_
  side, which is where `MXAppExitMetric` lives. Their stated reason:
  aggregated 24h delivery doesn't map cleanly onto Sentry's
  per-transaction event model. So `MXAppExitMetric` is an explicit gap
  that we close ourselves if we want it.
- Crashes are not captured via MetricKit at all on the Sentry-cocoa
  side — they're caught by sentry-cocoa's own crash reporter. Don't
  double-instrument.

### 7.2 Scope and platform availability

- **iOS only.** Android already covered by Phase 6.
- **iOS 14+** for `MXAppExitMetric`. iOS 13 has `MXMetricPayload` but no
  `applicationExitMetrics` field. Pre-14 sets a one-time scope tag
  `appExitMetrics.supported=false` and no-ops.
- One subscriber, owned by `AppLifecycleDelegate` (iOS-side module-load
  path; same place that owns the existing `NodeJSService` boot wiring).

### 7.3 What gets captured

Per `MXMetricPayload` delivery, parse `payload.applicationExitMetrics`
(an `MXAppExitMetric`). It exposes two child objects:

- `foregroundExitData` (`MXForegroundExitData`):
  `cumulativeNormalAppExitCount`, `cumulativeMemoryResourceLimitExitCount`,
  `cumulativeBadAccessExitCount`, `cumulativeAbnormalExitCount`,
  `cumulativeIllegalInstructionExitCount`,
  `cumulativeAppWatchdogExitCount`.
- `backgroundExitData` (`MXBackgroundExitData`): the foreground set
  above, plus `cumulativeMemoryPressureExitCount`,
  `cumulativeSuspendedWithLockedFileExitCount`,
  `cumulativeBackgroundTaskAssertionTimeoutExitCount`,
  `cumulativeCPUResourceLimitExitCount`.

Emission: **one Sentry event per individual exit**, not one event per
bucket. If a delivered payload reports
`backgroundMemoryPressureExitCount=3`, we emit three identical events.
Rationale: iOS app-exit volumes are tiny (typical production apps see
single digits per user per day across all buckets), the duplication is
negligible, and every dashboard query becomes a trivial `count(*)`
instead of a sum-over-extras. Each event carries a stable `window_id`
tag (`<timeStampBegin epoch>-<bucket>`) so analyses that want to collapse
back to per-window distinct counts can do so. Zero-count buckets emit
nothing, so the no-op-day case stays free.

### 7.4 New files

- `ios/AppExitMetricsCollector.swift` — `NSObject`-conforming class
  implementing `MXMetricManagerSubscriber`. One method:
  `didReceive(_ payloads: [MXMetricPayload])`. Decoded buckets are
  forwarded to `SentryNativeBridge` (existing) for the actual capture
  call.
- `ios/AppExitMetricsCollectorTests.swift` — XCTest module. Hand-build
  mocked `MXMetricPayload` JSON blobs (MetricKit payloads expose
  `jsonRepresentation()` and can be reconstructed via
  `MXMetricPayload(jsonRepresentation:)` on iOS 17+; on iOS 14–16, fall
  back to a small protocol the collector accepts so the test injects a
  fake without instantiating `MXMetricPayload` directly).

### 7.5 Subscription wiring

- Subscribe via `MXMetricManager.shared.add(collector)` in
  `AppLifecycleDelegate.didFinishLaunchingWithOptions` (or the
  Expo-equivalent module-load entry point), guarded on iOS 14+.
- Subscribe **once per process lifetime**; subscribing more than once
  produces duplicate deliveries. Use a static `Bool` guard on the
  collector.
- Unsubscribe in `applicationWillTerminate` for cleanliness, though
  Apple's lifecycle docs note this is best-effort —
  `applicationWillTerminate` doesn't fire on system kills.
- MetricKit delivery is async and typically happens ~24h after launch.
  The collector must be alive for _future_ deliveries, not the launch
  where it was registered. There's no back-fill — the first day of data
  is lost. Document this so dashboard math accounts for a "warm-up day"
  per fresh install.

### 7.6 Sentry emission shape

Message: `"ios exit: <bucket_name>"` — e.g.
`"ios exit: background_memory_pressure"`, `"ios exit: foreground_watchdog"`.
Bucket names are derived from the MetricKit field name with `cumulative`
and `ExitCount` stripped and snake-cased.

| Tag                | Value                                                                                                                                                                                                                                                         | Notes                                                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `proc`             | `main`                                                                                                                                                                                                                                                        | iOS is single-process; tag matches Android RN-side captures.                                                                                                                       |
| `layer`            | `native`                                                                                                                                                                                                                                                      | Same convention as the iOS state captures.                                                                                                                                         |
| `exit.cohort`      | `foreground` · `background`                                                                                                                                                                                                                                   | Top-level split — `background_*` buckets are the ones the user cares about for "is my app surviving in the background?".                                                           |
| `exit.bucket`      | bucket name (see message)                                                                                                                                                                                                                                     | Slice axis.                                                                                                                                                                        |
| `exit.intentional` | `true` for `normal_app_exit`; `false` for everything else                                                                                                                                                                                                     | Matches Phase 6's tag for the same semantic split.                                                                                                                                 |
| `exit.cause_class` | `memory` (`memory_resource_limit`, `memory_pressure`, `cpu_resource_limit`) · `watchdog` (`app_watchdog`, `background_task_assertion_timeout`) · `crash` (`bad_access`, `illegal_instruction`, `abnormal`) · `lock` (`suspended_with_locked_file`) · `normal` | Higher-level grouping for dashboards.                                                                                                                                              |
| `window_id`        | `<timeStampBegin epoch ms>-<bucket>`                                                                                                                                                                                                                          | Stable across the duplicate events emitted for one window+bucket. Lets analyses collapse `count(*)` back to "distinct windows that saw this bucket" via `count_unique(window_id)`. |

| Extra field               | Value                                                                                                                                                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `window_count`            | The cumulative bucket value from this payload (= the number of duplicate events emitted for this window+bucket). Per-event drill-down only; aggregate via `count(*)` on the events themselves rather than summing this field. |
| `window_start_iso`        | `payload.timeStampBegin` ISO-8601.                                                                                                                                                                                            |
| `window_end_iso`          | `payload.timeStampEnd` ISO-8601.                                                                                                                                                                                              |
| `window_duration_seconds` | Derived. Sanity-check for "is this actually a 24h window?".                                                                                                                                                                   |
| `app_version`             | `payload.metaData.applicationBuildVersion` if present.                                                                                                                                                                        |
| `os_version`              | `payload.metaData.osVersion` if present.                                                                                                                                                                                      |

Level mapping (per bucket):

| Bucket                                                                                                                                                                | Level                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `background_memory_pressure` · `background_memory_resource_limit` · `background_task_assertion_timeout` · `background_cpu_resource_limit` · `background_app_watchdog` | `error` — the "battery/background kill" cohort we explicitly want visibility on                                                                                             |
| `foreground_app_watchdog` · `foreground_memory_resource_limit` · `foreground_cpu_resource_limit`                                                                      | `error` — user-visible quality issues                                                                                                                                       |
| `*_bad_access` · `*_illegal_instruction` · `*_abnormal`                                                                                                               | `warning` — sentry-cocoa's own crash reporter captures the actual crash; this is just the matching post-mortem count, useful for cross-reference but not the primary signal |
| `*_normal_app_exit` · `*_suspended_with_locked_file`                                                                                                                  | `info`                                                                                                                                                                      |

Breadcrumb category: reuse `comapeo.exit` from Phase 6's
`SentryCategories` addition.

The events-over-metrics choice mirrors Phase 6 — see §6.5.1 for the
reasoning.

### 7.7 Phase 7b — heuristic per-event anchor (optional sub-phase)

`MXAppExitMetric` has no per-event timestamps. To answer "the app was
alive for X seconds before the system killed it in the background" at
any resolution, layer a heuristic on top:

- In `applicationDidEnterBackground`, write
  `{ state: "background", at: <wall_ms> }` to `UserDefaults`.
- In `applicationWillEnterForeground`, write `state: "foreground"`.
- In `applicationWillTerminate`, write
  `{ state: "terminated_clean", at: <wall_ms> }`.
- On every cold start: if the previous-session record exists and
  `state ∈ {"background", "foreground"}` (i.e. no clean termination
  marker), emit a Sentry event `"ios kill inferred"` tagged
  `ios.killed_in_background:true|false` (depending on the recorded
  state) with `last_known_state` and `time_since_last_state_ms`. Then
  overwrite the record so the inference fires once per actual incident.

Two things to be honest about:

- This heuristic catches _any_ unclean termination, including jetsam,
  watchdog, user-force-quit, OS reboot, and crash. `MXAppExitMetric`
  (Phase 7a, above) and sentry-cocoa's crash reporter help disambiguate
  after the fact — combine the events on dashboards via `release` +
  timestamp proximity.
- `time_since_last_state_ms` is a lower bound. The state marker is only
  refreshed on lifecycle transitions, not periodically, so if the app
  sat in the background for 30 minutes and was killed at the end, the
  value will be ~30min — which is what we want. But if the user
  force-quit at minute 5 without the marker being refreshed
  mid-background, we still report ~5min, which understates the system's
  tolerance. Add a periodic refresh (`Timer` on `RunLoop.main`, 30s
  cadence, only while foregrounded so we don't drain battery) to
  mitigate.

Make 7b a separate sub-phase so 7a can ship without the heuristic
complexity if scope is tight.

### 7.8 Caveats that affect the implementation

- `MXMetricManager.shared.add(...)` must be called from a `@MainActor`
  context on iOS 17+; the collector's `add()` call goes through
  `DispatchQueue.main.async`. The collector itself doesn't need to be
  `@MainActor` — only the registration call.
- Payloads arrive at unpredictable times. There's no `onLaunch`
  guarantee — `didReceive` may fire mid-session. Sentry capture from
  off-main is fine (sentry-cocoa is thread-safe).
- The `cumulative*` fields are aggregates **across the reporting
  window**, not since-app-install. Don't subtract previous payloads —
  each payload is self-contained.
- iOS may deliver an empty `MXMetricPayload` (no exits in the window).
  Handle gracefully — `applicationExitMetrics` is optional. No emission
  needed when all buckets are 0.
- `MXMetricPayload.jsonRepresentation()` returns rich JSON, but
  capturing the whole blob as an extra would blow Sentry's event size
  budget on a busy week. Decompose into buckets as above instead.
- TestFlight builds don't get MetricKit data; only App Store builds and
  Xcode-attached debug sessions do. The Phase 7 feature is invisible in
  beta channels — flag this on rollout so the team doesn't conclude
  "the integration is broken".
- The `applicationExitMetrics` API spec doesn't promise stable bucket
  lists across iOS versions. Future iOS releases could add buckets;
  decode helpers fall through to `unknown:<key>` the way Phase 6
  handles unknown `REASON_*` ints.

### 7.9 Tests

- `AppExitMetricsCollectorTests.swift`: inject a fake payload source.
  Cover:
  - Zero-count buckets emit nothing.
  - Non-zero foreground / background buckets emit the right tags and
    level for each.
  - **Per-exit duplication**: a bucket with count=N produces exactly N
    events with identical tags + identical `window_id`; a bucket with
    count=0 produces zero events.
  - Multiple non-zero buckets in one payload each duplicate
    independently (e.g. count=2 memory_pressure + count=1 watchdog → 3
    events total, two `window_id`s).
  - `exit.intentional` and `exit.cause_class` derive correctly.
  - Pre-iOS-14 guard short-circuits with the `supported=false` tag and
    no captures.
- `AppKillHeuristicTests.swift` (7b only): mock `UserDefaults` + a
  clock; assert:
  - Clean termination marker prevents the next-launch inference.
  - Stale marker fires once and is then cleared.
  - Foreground vs background marker drives `ios.killed_in_background`
    correctly.

No iOS instrumentation test — exercise-by-eye on a real TestFlight +
App Store build for 7a, and a manual jetsam test (`/usr/bin/MemoryLogger`
or the Xcode "Simulate Memory Warning" → background → kill flow) for 7b.

### 7.10 Out of scope for Phase 7

- Per-event timestamps for `MXAppExitMetric`. Apple doesn't expose them;
  the 24h-aggregate constraint is a platform limitation, not something
  we can engineer around.
- Background-task-budget instrumentation (how close to the ~30s
  assertion expiry were we when iOS suspended us?). Worth a separate
  small phase if `background_task_assertion_timeout` shows up
  frequently in the dashboard — the budget-remaining read is
  `UIApplication.shared.backgroundTimeRemaining`, cheap, but it's
  runtime telemetry rather than post-mortem.
- iOS metric payloads other than `applicationExitMetrics` (signpost
  histograms, cell network counts, etc.). Different product question;
  not in this phase's frame.

Value: the first quantitative answer to "is iOS killing our backend in
the background, and which class of kill is it?". Combined with Phase 6
the team has a per-OS framing of the same underlying product question
— "does our backend stay alive long enough on this user's device?".

Cost: ~150 LOC Swift + ~80 LOC tests for 7a. Add ~80 LOC + ~50 LOC tests
for 7b. No JS/Android/backend changes.

---

## Phase 8 — refinements

- Tune sample rates from production data.
- Optional: dual backend bundles for Sentry-free consumers if bundle
  size becomes a concern.

---

## Phase 9b — privacy hardening

The plumbing in Phase 9a landed the _gating shape_; the captures
themselves still need to be hardened to honour the distinctions the
tiers promise. This is Phase 9b, broken into smaller deliverables.

### 9b.1 PII scrubber (`beforeSend`)

The substring-scan promised in the hard never-capture list (see
[`sentry-integration.md` §8](./sentry-integration.md#hard-never-capture-list))
— defensive net for `rootKey`, base64-22-char strings (rootkey shapes),
`lat=` / `lng=` / `latitude:` / `longitude:`, and any other token
CoMapeo treats as sensitive. Lives in this module, wired in
`initSentry` BEFORE the host's `beforeSend` chain so a malicious or
buggy host can never see an unscrubbed payload. The `beforeSend` chain
shape is already wired (identity placeholder at `src/sentry.ts:233`);
this lands the function body.

Symmetric implementation in `backend/loader.mjs`'s
`Sentry.addEventProcessor` so the same scrub runs on Node-side events.
Same regex list, same drop behaviour. A shared list keeps it in sync;
copy via build step or duplicate by hand with a comment pointing both
ways.

The scrubber walks `event.message`, `event.exception[*].value`,
`event.extra`, `event.contexts`, every breadcrumb's `message` + `data`,
and every span's `description` + `attributes`. Trade-off between
false-positive aggressiveness and signal preservation documented
inline with example matches.

### 9b.2 `user.id` — installation UUID + monthly rotation

A stable per-install UUID owned by native (because the FGS process
needs it before RN starts):

- **Storage**: `ComapeoPrefs` adds a `sentry.installationId` key.
  Generated lazily on first read as `UUID.randomUUID().toString()` on
  Android / `UUID().uuidString` on iOS. Persisted in `SharedPreferences`
  (cleared on uninstall) — explicitly **not** Keychain; we want
  uninstall to genuinely reset identity.
- **Computation**:
  - Diagnostic tier:
    `user.id = sha256(installationId + utc_year_month).slice(0, 16)`
    where `utc_year_month` is `YYYY-MM` (current UTC). Hash rotates
    monthly so cross-month traces don't link.
  - App-usage tier: `user.id = installationId` (raw stable ID).
  - When a user shares their `installationId` (e.g. for a bug report),
    we can recover the diagnostic hashes back to them.
- **Distribution**: native computes once at process start, exposes on
  the existing `sentryConfig` Expo constant as `userId`. Backend
  loader receives it via `--sentryUserId=...` argv. All three SDKs use
  the same value via `Sentry.setUser({ id })` (locked — host can't
  override).
- **On toggle-flip**: the `installationId` itself doesn't rotate on
  `diagnosticsEnabled` toggle (that would defeat bug-report
  recoverability). When the user goes `app-usage on → off`, the next
  launch's `user.id` changes (raw → monthly hash); that's the intended
  boundary.

### 9b.3 Context field reclassification

The original §9.8.5.3 design split a Node-side `SentryNativeContext`
blob across diagnostic vs app-usage tiers. **Superseded by Phase 10's
offline-transport forwarder.** `SentryNativeContext.{kt,swift}` was
deleted — Node events are deserialised on the native side and captured
via `Sentry.captureEvent`, so the FGS-side `sentry-android` /
`sentry-cocoa` SDK applies its own scope (with its own field set) at
capture time. Re-specify against the native SDKs' `beforeSend` hook
(filter scope fields per tier on the wire out), not against a Node-side
context blob. The privacy goals still apply:

- **Diagnostic tier emits**:
  - `device`: `manufacturer`, `brand`, `model`, `model_id`, `family`,
    `arch`, `simulator`, `processor_count`, `memory_size`,
    `storage_size` (bucketed to standard sizes:
    32/64/128/256/512/1024 GB).
  - `os`: `name`, `version` only. **Drop** `kernel_version` (both),
    `build` (Android `Build.DISPLAY`). iOS `kern.osversion` redundant
    with `version`, drop too.
  - `app`: `app_identifier`, `app_version`, `app_build`. **Drop**
    `app_name`.
  - `culture`: **drop entirely** at diagnostic tier (locale + timezone
    are high-entropy fingerprint surfaces).
  - `device.screen_resolution`, `device.screen_density`,
    `device.screen_dpi`: **drop**.
- **App-usage tier adds**: kernel_version, Android `Build.DISPLAY`,
  `app_name`, full `culture` block, screen metrics.

### 9b.4 Boot transactions: keep on diagnostic, minimise

Boot transactions stay always-on (option (b) from the original design
discussion), but the timing-shape data they carry is minimised under
the diagnostic tier:

- Strip user-shape fields from boot-transaction attributes — no
  background-duration anchors, no foreground-state tags, no per-event
  culture data riding alongside.
- Keep phase-span shape (`boot.fgs-launch`, `boot.extract-assets`,
  `boot.node-spawn`, `boot.loader-init` + its
  `boot.loader-import-sentry-node` and `boot.import-index` children,
  `boot.manager-init`, `boot.rootkey-load`) — that's the actionable
  perf signal.
- Span `description` strings stay minimal — the phase identifier
  (`"boot.<phase>"`) is in `op` and serves as the description too;
  any longer prose lives in source-code comments. No file paths,
  user-shape data, or other potentially-sensitive strings ride on the
  wire.

### 9b.5 Network breadcrumb URL scrubbing

`@sentry/react-native`'s default `httpIntegration` records every
`fetch` / `XMLHttpRequest` URL + status code as a breadcrumb. URLs can
leak which CoMapeo Cloud account / project / map tile server a user
talks to. Two options:

- Disable `httpIntegration` from our defaults entirely. Cheapest; most
  aggressive.
- Keep it but install a `beforeBreadcrumb` that scrubs the URL to
  host-only (drop path, query string).

Recommend the latter — host-only URLs are still useful for diagnosing
"all our requests are failing" patterns. Implementation chains
alongside the PII scrubber.

### 9b.6 Backend free memory / disk reads

Phase 9a's cheap fix (attach `os.freemem` / `os.totalmem` /
`fs.statfsSync` to `handleFatal` exceptions) shipped already. The
periodic-update direction is still relevant for keeping
_Node-process_ memory / storage numbers fresh on _every_ event (not
just `handleFatal`). Re-specify as either:

- (a) a small "Node device context" event-processor in `loader.mjs`
  that re-reads `os.freemem` on each capture, or
- (b) periodic native → Node updates of a small allowlist of
  _Node-process_ metrics.

Whichever way, this is no longer a vehicle for native device/os/app
fields — those come from the native SDK's scope.

Scoped to app-usage tier because periodic memory polling is itself
usage-shape data (frequency reveals app activity).

### 9b.7 `consoleIntegration` gating

Move backend `consoleIntegration` from the always-on default to
app-usage. Today `backend/loader.mjs` adds it unconditionally; under
the new model, install it only when the loader receives a
`--captureApplicationData` argv flag (which native only passes when
the effective toggle is on).

### 9b.8 Phase 6 / Phase 7 reclassification

Phase 6 (Android exit reasons) — the _records themselves_ are
diagnostic-tier. The derived **`bg_duration_bucket`**,
**`uptime_bucket`**, and `comapeo.fgs.killed_in_background` fields
rely on background-duration anchors that themselves are app-usage-tier
data. Reclassify in the Phase 6 spec: those tags only flow when
capture-application-data is on. Phase 6 records without those tags
still ship at diagnostic (with `exit.reason`, `exit.process_state`,
`oem.killer.suspected`, `exit.intentional`).

Phase 7 (iOS app-exit metrics) — the bucket events themselves are
diagnostic-tier. The per-event multiplication (`window_count`
duplication) is app-usage-tier because frequency reveals session-shape
activity.

### 9b.9 Phase 6 timestamp anchor reset on toggle cycle

When `diagnosticsEnabled` flips `false → true`, Phase 6's
`lastSeenAtMs` high-water key resets to `currentTimeMillis()` so
records generated during the "off" window are NOT surfaced on
re-enable. Same behaviour for `captureApplicationData` and the
duration-anchor keys. Simple per-toggle hook on the setter path.

---

## Phase 11 — Metrics-first observability + `debug` tier

Shift day-to-day performance signal from per-RPC tracing to **Sentry
metrics** ([product docs](https://docs.sentry.io/product/explore/metrics/)),
keeping tracing as an investigation-only mode behind a new user-facing
`debug` toggle. Rename `captureApplicationData` → `applicationUsageData`
with refined semantics (stable `user.id` + usage events, no longer perf
tracing).

Motivation: Platformatic's [Hidden Cost of Async Context](https://blog.platformatic.dev/the-hidden-cost-of-context)
benchmarks show full OTel auto-instrumentation removes ~80% of throughput
and 4×s p99 latency. On a mobile RPC server the CPU number is invisible
at ~10 RPS, but the per-call envelope egress (battery + mobile data +
ingest $$$) and the always-on `Sentry.startSpan` + ALS wrapper are real
costs paid for a question — "what's our p95 of `observation.create` on
low-end Android?" — that a histogram answers more directly with no
egress per call.

Companion changes elsewhere:

- §11.4 supersedes [Phase 9b.2](#9b2-userid--installation-uuid--monthly-rotation)'s
  diagnostic-vs-app-usage gating for `user.id` rotation. The new
  contract: monthly hash whenever `applicationUsageData=false`, raw
  `installationId` whenever `applicationUsageData=true`. `debug` does
  not unlock stable `user.id`.
- §11.3 supersedes Phase 5's "per-RPC client + server spans" entry —
  RPC spans are now `debug`-only; metrics carry the day-to-day perf
  signal. Phase 5 retains the sync-session transaction and the
  `before_send` privacy processor.

### 11.1 Three-toggle model

Rename `captureApplicationData` → `applicationUsageData` and add `debug`.
All three are **orthogonal** but `applicationUsageData` and `debug` AND
with `diagnosticsEnabled` internally; host UI never has to mirror that.

| Toggle                 | What it gates                                                                                          | Default                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| `diagnosticsEnabled`   | `Sentry.init` runs. Errors, lifecycle, **metrics**, boot/sync/shutdown transactions.                   | `true` (per plugin)                 |
| `applicationUsageData` | Feature-usage breadcrumbs/counters + **stable `user.id`** (no monthly hash).                           | `false`                             |
| `debug`                | Per-RPC traces, `@comapeo/core` OTel spans, `consoleIntegration`, `rpcArgsBytes` capture (if plugin >0). | `false`                             |

Effective combinations:

| State                  | `Sentry.init` | Errors | Boot/sync trace | **Metrics** | Usage events | `user.id`        | Per-RPC trace |
| ---------------------- | ------------- | ------ | --------------- | ----------- | ------------ | ---------------- | ------------- |
| Off                    | –             | –      | –               | –           | –            | –                | –             |
| Diagnostic (default)   | ✓             | ✓      | ✓               | ✓           | –            | sha256 monthly   | –             |
| Diag + Usage           | ✓             | ✓      | ✓               | ✓           | ✓            | **stable**       | –             |
| Diag + Debug           | ✓             | ✓      | ✓               | ✓           | –            | sha256 monthly   | ✓ 100%        |
| Diag + Usage + Debug   | ✓             | ✓      | ✓               | ✓           | ✓            | stable           | ✓ 100%        |

### 11.2 Metrics inventory (always-on at diagnostic)

All recordings use `Sentry.metrics.distribution(...)` /
`Sentry.metrics.increment(...)` /
`Sentry.metrics.gauge(...)` from `@sentry/node-core` v10 (Node) and
`@sentry/react-native` v7+ (RN). Envelopes ride the existing forwarding
transport (`backend/lib/sentry.js` `forwardingTransport`) — same DSN,
same control-socket → native sink, same offline-aware native queue. No
new pipeline.

Tags follow strict low-cardinality rules (see §11.8). Three **default
tags** are attached by `metrics.js` to every emission so we can never
forget them at the call site:

- `platform` (`ios` / `android`)
- `device_class` (`low` / `mid` / `high` — see §11.2.b)
- `os_major` (`ios.17`, `android.13`, …)

#### 11.2.a Metric inventory

The first metric in each pair carries per-method detail for "which
operation is slow"; the `.by_device` mirror exists where the
device-slowness question is interesting and keeps per-method ×
per-device cardinality bounded (§11.2.c).

| Metric                                       | Type         | Tags                                                  | Source                              |
| -------------------------------------------- | ------------ | ----------------------------------------------------- | ----------------------------------- |
| `comapeo.rpc.server.duration_ms`             | distribution | `method`, `status` + defaults                         | `backend/lib/sentry.js` `rpcHook`   |
| `comapeo.rpc.server.duration_ms.by_device`   | distribution | `status` + defaults                                   | same call site                      |
| `comapeo.rpc.server.errors`                  | counter      | `method`, `error_class` + defaults                    | server hook on catch                |
| `comapeo.rpc.client.duration_ms`             | distribution | `method`, `status` + defaults                         | `src/ComapeoCoreModule.ts` hook     |
| `comapeo.rpc.client.duration_ms.by_device`   | distribution | `status` + defaults                                   | same call site                      |
| `comapeo.rpc.client.send_ms`                 | distribution | `method` + defaults                                   | existing `rn.send.syncMs` measurement |
| `comapeo.boot.phase_duration_ms`             | distribution | `phase` (`fgs-launch`, `extract-assets`, `node-spawn`, `loader-init`, `manager-init`, `rootkey-load`) + defaults | each boot-span `end()`              |
| `comapeo.boot.phase_duration_ms.by_device`   | distribution | `phase` + defaults                                    | same call site                      |
| `comapeo.boot.outcome`                       | counter      | `outcome` (`started` / `error`), `error_phase?` + defaults | `STARTED` / ERROR transition        |
| `comapeo.sync.session.duration_ms`           | distribution | `outcome` + defaults                                  | sync session end                    |
| `comapeo.sync.session.duration_ms.by_device` | distribution | `outcome` + defaults                                  | same call site                      |
| `comapeo.sync.session.peers_bucket`          | counter      | `bucket` (`1-3` / `4-10` / `10+`) + defaults          | session start                       |
| `comapeo.sync.bytes_bucket`                  | counter      | `bucket` (`<1M` / `1-10M` / `10-100M` / `100M+`) + defaults | session end                         |
| `comapeo.backend.memory_rss_bytes`           | gauge        | defaults only                                         | 60s timer in `backend/index.js`     |
| `comapeo.backend.heap_used_bytes`            | gauge        | defaults only                                         | same timer                          |
| `comapeo.fgs.uptime_s`                       | gauge        | defaults only                                         | same timer                          |
| `comapeo.state.transitions`                  | counter      | `from`, `to` + defaults                               | every `stateChange`                 |

#### 11.2.b Device classification

Raw `device.model` would explode metric cardinality (~2,000 distinct
values on Android alone, × methods × statuses). The classification
bucket gives us the actionable signal — "low-end devices are 4× slower
at `observation.create`" — at low cardinality. Raw model/manufacturer
stay on Sentry's event/trace scope (already attached via native SDK
scope per [`sentry-integration.md` §7.3](./sentry-integration.md#73-native-telemetry-data-design)),
so one debug-mode trace from the slow bucket gives the specific model.

Thresholds (revisit with comapeo-mobile's low-end device list if one
exists; otherwise these are first-cut):

| Class  | Memory      | Cores       |
| ------ | ----------- | ----------- |
| `low`  | < 3 GB      | OR < 4      |
| `mid`  | 3–6 GB      | AND 4–6     |
| `high` | ≥ 6 GB      | AND ≥ 6     |

Computed once at native process start; cached on the `SentryConfig`
object alongside DSN/environment/release. Plumbed:

- to RN via the existing `readSentryConfig()` Expo constant (extended
  with a `deviceTags` field);
- to Node via new argv flags `--deviceClass`, `--osMajor`,
  `--platformTag` (parsed in `loader.mjs`, stored on the singleton in
  `backend/lib/sentry.js`).

`os_major` is `<platform>.<major>` — `Build.VERSION.RELEASE.split(".")[0]`
on Android, `UIDevice.systemVersion.split(".")[0]` on iOS. Major-only
because point releases rarely move the perf needle and would expand
cardinality unnecessarily.

#### 11.2.c Cardinality math

Per-metric series ceiling with the default tags applied:

- Base from defaults: 2 (platform) × 3 (device_class) × ~10 (os_major)
  = **60** combinations.
- `rpc.server.duration_ms` with `method` (~50) × `status` (3) on top:
  60 × 150 = **9,000** series. Sentry's metric-cardinality guidance
  warns above ~10k; leaves headroom for one more low-cardinality tag
  if we discover one we need.
- `.by_device` variant drops `method`, so base × `status` (3) = **180**.
  Cheap.
- `boot.phase_duration_ms` (~6 phases × 3 status-equivalent) ≈ 1k.
- `state.transitions` (5 states × 5 states = 25 valid pairs) × 60 = 1.5k.

Total across all metrics: ~25k series at steady state. Cost-comparable
to typical web-app instrumentation; well-bounded.

#### 11.2.d Why bucketed device tags, not raw

Two practical pitfalls if we tagged with raw `device.model`:

1. **Cardinality cost** — ~2,000 Android model strings × 50 methods × 3
   status × ~10 OS-major = ~3M series for one metric. Unaffordable on
   any Sentry plan and unusable on dashboards.
2. **Long-tail noise** — a histogram with 10 samples from "Tecno Spark
   7" isn't actionable. Bucketed by class, the same 10 samples become
   "12,847 low-end Android samples this hour, p95 480ms" and we can
   act on it.

Raw model stays on the event/trace side (Sentry's native SDK scope
attaches it today). When a metric flags "low-end Android 11 is bad,"
one `debug`-mode trace from that bucket gives the actual model in
`device.model` + `device.manufacturer`.

### 11.3 Trace inventory

**Always-on essential (diagnostic tier, 100% sample, not gated by `debug`):**

- `comapeo.boot` transaction + phase children — once per launch.
- `comapeo.shutdown` transaction + phase children — once per launch.
- `comapeo.sync.session` transaction (top-level only; no per-peer or
  per-block child spans). Span attributes restricted to bucketed peer
  count, bucketed bytes, outcome. Frequency-bounded by sync sessions
  themselves so volume stays low.

**Gated on `debug=true` (100% sample while on):**

- `rpc.client` span (JS) + `rpc.server` transaction (Node) per RPC.
- `@comapeo/core` PR #1051 OTel spans (inherit the RPC parent — when
  `debug=on` the parent exists).
- `consoleIntegration` breadcrumbs on backend (currently always-on per
  `backend/lib/sentry.js:127`; moves to `debug`-only, superseding the
  Phase 9b.7 plan).
- `rpc.args` span attribute when `rpcArgsBytes>0` in plugin AND
  `debug=true`. (Two gates because `rpcArgsBytes` is build-time
  developer config and `debug` is runtime; both must agree.)

100% sample on `debug` because the user-bounded window keeps total
volume small. No partial sampling logic in v1.

### 11.4 `applicationUsageData` redefined

Previously this gated per-RPC tracing + the perf grab bag. After this
phase it gates only:

1. **Stable `user.id`** — disables the monthly hash rotation specified
   in Phase 9b.2. Locks to raw `installationId`. Without
   `applicationUsageData` the user.id rotates monthly across
   diagnostic captures (cohort-unlinkable). With it on, stable across
   launches and months (cohort analysis works).
2. **Usage breadcrumbs / counters** — a module-supplied helper:

   ```ts
   import { recordUsage } from "@comapeo/core-react-native/sentry";
   recordUsage.screen("ObservationList");
   recordUsage.feature("export.geojson");
   ```

   Emits a `comapeo.usage.*` breadcrumb (for crash-context) and a
   `comapeo.usage.{screen,feature}` counter (for aggregate cohort
   analysis). No-op when `applicationUsageData=false`. The module
   ships the helper; the consumer decides which screens/features to
   instrument.

3. **Background/foreground breadcrumbs** (from Phase 5 — moves here as
   the natural home for "how is the app used" data).

What this no longer unlocks (compared to the old `captureApplicationData`):

- Per-RPC tracing → moved to `debug` (§11.3).
- `rpc.args` capture → still requires plugin's `rpcArgsBytes>0` AND
  `debug=true`.
- Anything on the [§8 hard never-capture list](./sentry-integration.md#hard-never-capture-list).

### 11.5 `debug` toggle — shape

User-facing in settings, restart-to-activate, same pattern as the other
two toggles.

```ts
export function getDebugEnabled(): boolean;
export function setDebugEnabled(value: boolean): Promise<void>;
```

- **Storage**: `ComapeoPrefs` key `sentry.debug`. Default `false`.
- **Plugin default**: `debugDefault` field, default `false` everywhere
  (including internal builds — the workflow is "support tells the
  user to flip Debug on, reproduce, send the trace link, flip it
  off"; baking it on for QA would dilute the signal).
- **Argv**: `--debug` (boolean flag, native passes only when on).
- **Effective gates** (enforced inside the module, never in host UI):
  - `Sentry.init` requires `diagnosticsEnabled`.
  - Usage events / stable `user.id` require `diagnosticsEnabled && applicationUsageData`.
  - Per-RPC traces require `diagnosticsEnabled && debug`.
  - `rpc.args` requires `diagnosticsEnabled && debug && rpcArgsBytes>0`.
- **Breadcrumb on transition**: `comapeo.debug.enabled` /
  `comapeo.debug.disabled` so the timeline records when a session was
  diagnostic-only vs. tracing.
- **`tracesSampleRate`**: `debug ? 1.0 : 0` (full sample because the
  window is user-bounded; no partial sampling). Replaces the current
  `applicationUsageData ? 0.1 : 0` logic in
  `backend/lib/sentry.js:121-123` and `src/sentry.ts:227-229`.

#### 24h auto-off

`debug=true` auto-expires 24 hours after the most recent enable.
Bounds the cost of a user (or support engineer) forgetting to flip
it back off without forcing a per-session re-enable.

- **Storage**: new pref slot `sentry.debugEnabledAtMs` written
  synchronously alongside `sentry.debug=true`. Cleared on
  `debug=false`. Wall-clock (`currentTimeMillis()` / `Date()`) not
  monotonic so it survives reboots.
- **Check point**: at native process start (both the main process
  and the FGS, before argv is built). Single
  `now - storedTs > 24h` comparison; if true, the prefs writer
  flips `debug=false`, clears the timestamp, and queues a
  `comapeo.debug.auto_disabled` breadcrumb to fire on the next
  `Sentry.init`. Argv is built with `debug=false` for that launch.
- **Re-enable semantics**: `setDebugEnabled(true)` always writes a
  fresh `debugEnabledAtMs`. Calling it while already enabled
  refreshes the 24h window — toggling at 23h59m gives another 24h.
- **Clock skew**: winding the system clock forward triggers early
  auto-off; backward delays it. Acceptable — this is a best-effort
  cost guardrail, not a security boundary.
- **Edge case**: `debug=true` with no timestamp (older install
  predating Phase 11 with the cell missing) → treat as "enabled
  now"; write the timestamp on first read so the 24h clock starts
  cleanly. Not reachable in practice since Phase 11 ships the slot
  alongside the toggle, but cheap to handle.

**v1 guardrails not included** (track for v2 if needed):

- Sample-rate cap. Add only if support reports forgotten-debug-on
  sessions filling Sentry — but the 24h auto-off above is the
  primary mitigation, so this is unlikely to be needed.

### 11.6 Code changes by file

#### Toggle plumbing (rename + new)

- `src/sentry.ts` — rename `getCaptureApplicationData` /
  `setCaptureApplicationData` → `…ApplicationUsageData`; add
  `get/setDebugEnabled`; `initSentry` reads all three prefs.
  `tracesSampleRate` derived from `debug` (not from
  `applicationUsageData`).
- `src/ComapeoCoreModule.ts` — rename native bridge methods; add
  `setDebugEnabledNative`; `readSentryPreferences()` returns
  `{ diagnosticsEnabled, applicationUsageData, debug }`. The
  `onRequestHook` (`:207-277`) splits into:
  - always: `performance.now()` delta + `metrics.rpcClient(method, status, ms)` + dual write to `.by_device`;
  - when `debug`: the existing `Sentry.startSpan` /
    `startNewTrace` / `getTraceData` block, including
    `hasInheritableActiveSpan` plumbing.
- `android/src/main/java/com/comapeo/core/ComapeoPrefs.kt` — rename
  `captureApplicationData` key + reader/writer; **one-shot migration**
  on open: if old key present and new absent, copy then delete. Add
  `sentry.debug` slot and `sentry.debugEnabledAtMs` slot. The
  `readDebugEnabled()` reader implements the §11.5 24h auto-off: if
  the stored age exceeds 24h, flips `debug=false`, clears the
  timestamp, queues the `auto_disabled` breadcrumb, returns `false`.
  The setter writes the timestamp synchronously alongside the value.
- `android/src/main/java/com/comapeo/core/SentryConfig.kt` — rename
  `captureApplicationDataDefault`; add `debugDefault` and
  `deviceTags` (computed via new `DeviceTags.kt`).
- `android/src/main/java/com/comapeo/core/ComapeoCoreService.kt` —
  argv now includes `--applicationUsageData`, `--debug`,
  `--deviceClass`, `--osMajor`, `--platformTag`.
- `android/src/main/java/com/comapeo/core/DeviceTags.kt` (new) —
  `classify(ctx): DeviceTags(platform, deviceClass, osMajor)`. Uses
  `ActivityManager.MemoryInfo.totalMem` +
  `Runtime.getRuntime().availableProcessors()`. Cached lazy.
- `ios/ComapeoPrefs.swift`, `ios/SentryConfig.swift`,
  `ios/AppLifecycleDelegate.swift` — mirror the Android changes,
  including `sentry.debugEnabledAtMs` and the auto-off reader logic.
- `ios/DeviceTags.swift` (new) — same shape; `ProcessInfo.physicalMemory`
  + `ProcessInfo.processorCount`.
- `app.plugin.js` — rename `captureApplicationDataDefault` →
  `applicationUsageDataDefault`; add `debugDefault`. Validation: warn
  (don't error) on `captureApplicationDataDefault` for one minor with
  a pointer to the new field.
- `backend/lib/sentry.js` — rename `captureApplicationData` field in
  `argSpec` + `Argv` typedef → `applicationUsageData`; add `debug`,
  `deviceClass`, `osMajor`, `platformTag`. Update `init`:
  ```js
  tracesSampleRate: argv.debug ? 1.0 : 0,
  // rpcHook registered only when debug; metrics layer always-on at diagnostic
  ```
  Split `rpcHook` (`:282-341`): always call
  `metrics.rpcServer(method, status, ms)`; only run the
  `continueTrace` + `startSpan` block when `argv.debug`.
- `backend/loader.mjs` — parse the new argv flags through the existing
  `sentry.argSpec` machinery.

#### New metrics module

- `backend/lib/metrics.js` (new) — module-private wrapper around
  `Sentry.metrics.*`. Singletons populated from `sentry-init.js`.
  Exports:
  - `rpcServer(method, status, ms)` — writes both the
    `…duration_ms{method,status}` distribution and the
    `…by_device{status}` distribution.
  - `rpcServerError(method, errorClass)` — counter.
  - `bootPhase(phase, ms)` — dual-write.
  - `syncSession(outcome, ms, peersBucket, bytesBucket)` — three writes.
  - `backendMemorySample()` — three gauges from `process.memoryUsage()`.
  - `stateTransition(from, to)` — counter.
  - `usageScreen(name)`, `usageFeature(name)` — counters, no-op unless
    `applicationUsageData=true`.
  - Internal `defaultTags` built once from
    `{platform, deviceClass, osMajor}` argv; merged on every write so
    call sites can't forget.
  - No-ops entirely when Sentry is off.
- `backend/lib/sentry-init.js` — also export `Sentry.metrics` for
  `metrics.js` to consume; no additional dependency (it's part of
  `@sentry/node-core` v10).
- `backend/index.js` — register periodic memory gauge timer when
  `diagnosticsEnabled` (was Phase 5 opt-in; promote). Each
  `boot.<phase>` span end calls `metrics.bootPhase(phase, ms)`
  alongside `span.end()`. Wire `metrics.stateTransition(...)` on
  every state change.
- `backend/lib/comapeo-rpc.js` — pass-through; the actual recording
  lives in `sentry.js`'s `rpcHook` since that's where method + status
  + duration are known.
- `src/sentry-metrics.ts` (new) — RN-side mirror. Exports
  `recordUsage.{screen,feature}` (no-op unless `applicationUsageData`)
  and internal helpers for RPC metric recording. Same `defaultTags`
  shape, read from `sentryConfig.deviceTags`.

#### Trace simplification

- `src/ComapeoCoreModule.ts:198-203` — `hasInheritableActiveSpan` /
  `startNewTrace` plumbing stays but moves inside the `debug` branch.
  With per-RPC tracing gated on `debug` only, the App-Start race no
  longer exists for the diagnostic tier and the plumbing becomes
  cold code outside debug windows.
- `backend/lib/sentry.js:282-341` `rpcHook` — `forceTransaction: true`
  stays for `debug` mode; without `debug`, the hook returns
  `undefined` so the RPC server skips middleware entirely (the
  metric is recorded in a sibling, always-on shim).

#### Docs

- `docs/sentry-integration.md` §9 — rewrite the tier table; rename
  `captureApplicationData` → `applicationUsageData` throughout; add
  `debug` row. Add a §9.6 cross-link to this Phase 11 for the
  metrics inventory and gating.
- `docs/sentry-integration-history.md` — append Phase 11 entry once
  landed.

### 11.7 Migration of existing consumers

- **Plugin field**: `captureApplicationDataDefault` continues to be
  read for one minor but logs a deprecation warning pointing to
  `applicationUsageDataDefault`. Drop in the minor after.
- **Prefs key**: one-shot migration on first open of `ComapeoPrefs`:
  if `sentry.captureApplicationData` exists and `sentry.applicationUsageData`
  does not, copy then delete the old key. Idempotent.
- **JS API**: `getCaptureApplicationData` / `setCaptureApplicationData`
  re-exported with `@deprecated` JSDoc forwarding to the new names
  for one minor. Drop in the minor after.
- **Native bridge methods**: same deprecation shape; old method names
  forward to new for one minor.
- **Behaviour at the boundary**: a user with `captureApplicationData=true`
  today gets `applicationUsageData=true` after migration → keeps stable
  `user.id` + usage breadcrumbs. They also lose per-RPC tracing
  unless support flips `debug` on. This is the intended boundary —
  most users won't notice; the few hitting perf issues get a focused
  debug session rather than always-on traces.

### 11.8 Cardinality budget + forbidden tags

#### Allowed default tags (auto-attached by `metrics.js`)

- `platform`: 2 values
- `device_class`: 3 values
- `os_major`: ~10 values per platform

#### Allowed per-metric tags

- `method`: small enum (~50 RPC methods)
- `status`: 3 values (`ok` / `error` / `timeout`)
- `phase`: 6 boot phases / 3 shutdown phases
- `outcome`: 2 values
- `from` / `to`: 5 state enum each
- `bucket`: ≤ 4 values per bucket family
- `error_class`: bounded (`TimeoutError`, `IPCError`, `RpcError`, etc.)

#### Forbidden tags

These are off by construction on the metrics path, mirroring the
[§8 hard never-capture list](./sentry-integration.md#hard-never-capture-list):

- `device.model`, `device.id`, `device.manufacturer` — raw model
  stays on event/trace scope, NEVER on metrics.
- Raw `os.version` (use `os_major` only).
- `screen.resolution`, `screen.density`, `screen.dpi`.
- Locale, timezone.
- `project_id` (raw or hashed).
- `peer_id` of any kind, raw peer count (use `peers_bucket`).
- `rootkey` substring, base64-22-char strings.
- File paths.
- Lat/lng or quantised location.
- RPC method args (raw or sliced).

#### Defensive gate

A `before_metric_send` hook (cheap regex, same shape as `before_send`)
runs symmetrically on RN and Node sides. Drops emissions whose tag
names or values match a forbidden pattern. This is belt-and-suspenders
— the fix is always at the call site, but the hook catches typos and
copy-paste mistakes before they ship a high-cardinality tag.

Lands alongside `backend/before-send.js` from Phase 9b.1; the two
hooks share the regex list.

### 11.9 Test plan

- **Unit (Kotlin / Swift)**: `ComapeoPrefs` migration — old key
  present + new absent → new populated, old key deleted, value
  preserved. Both platforms.
- **Unit (Kotlin / Swift)**: `ComapeoPrefs.readDebugEnabled` 24h
  auto-off — fresh enable returns `true`; +23h59m returns `true`;
  +24h01m returns `false`, clears the timestamp, and the next
  read returns `false` with no further mutation. Setter refresh
  resets the window. Both platforms.
- **Unit (Kotlin / Swift)**: `DeviceTags` classification — boundary
  cases (exactly 3 GB RAM, exactly 4 cores, both platforms).
- **Unit (JS)**: `metrics.js` no-ops when Sentry off; records correct
  metric names + tags when on; applies default tags via the singleton.
- **Unit (JS)**: `before_metric_send` drops events with forbidden tag
  names (e.g. `project_id`) and forbidden tag values (raw base64-22).
- **Integration (Node)**: extend `backend/lib/sentry.test.mjs` —
  debug-off ⇒ `rpcHook` doesn't create a span; metric recorded.
  debug-on ⇒ span created and metric recorded.
- **Integration (RN)**: extend `src/__tests__/sentry.test.js` — same
  shape on the client side.
- **Manual smoke** (Sentry test project): flip each combination,
  verify on Sentry's metrics explorer:
  - Diagnostic only → boot trace present, error events present,
    `rpc.server.duration_ms` populated, no per-RPC traces, no
    usage breadcrumbs, `user.id` differs between two launches
    one month apart (mock by setting system clock).
  - + Usage → `comapeo.usage.*` counters appear, `user.id` stable
    across launches.
  - + Debug → per-RPC traces appear with `@comapeo/core` spans as
    children. Metrics still recording in parallel.
  - Verify `.by_device` metric splits cleanly across two physical
    test devices (different `device_class`).
- **Regression**: existing `e2e/run-instrumented-tests.sh` + Swift /
  Xcode test suites pass with all toggles off (Sentry inert).

### 11.10 Decisions

| Question                                            | Decision                                                                                                                                                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sentry plan availability for metrics ingestion      | Verified — metrics are included in the current plan. Land Phase 11 as drafted; no `.by_device` mirror drop needed.                                                                                                        |
| `comapeo.sync.session` transaction tier             | Always-on at diagnostic with bucketed attributes (current §11.3 draft). Trades a known small trace volume — one per sync session — for richer drill-down on the rare sync issues.                                          |
| Auto-off guardrail for `debug`                      | Ship 24h auto-off in v1 (see §11.5). Sample-rate cap deferred to v2 unless real support traffic demands it.                                                                                                                |
| `device_class` thresholds                           | Use the first-cut thresholds in §11.2.b (Low < 3 GB OR < 4 cores; Mid 3–6 GB AND 4–6 cores; High ≥ 6 GB AND ≥ 6 cores). Revisit post-landing if observed perf cliffs don't align — the table is straightforward to retune. |

---

## Test plan (remaining phases)

### Unit / integration

- `before_send` privacy processor: feed it events containing
  base64-shaped strings, latitude/longitude markers, and raw project
  IDs; assert each is redacted or dropped.
- Backend rollup output (re-verify when Phase 8 dual-bundle lands, if
  it does): assert the multi-entry build produces `loader.mjs`,
  `index.mjs`, `importHook.js`, and `lib/register.js`; that
  `loader.mjs` does not statically reference `@sentry/node`; that the
  rewritten `module.register('./importHook.js', ...)` call is in the
  bundled output (no bare `import-in-the-middle/hook.mjs` reference).
- Per-phase tests are detailed inline (see §6.9 for Phase 6, §7.9 for
  Phase 7).

### Manual smoke

- Run the example app with a temporary DSN (a test Sentry project)
  configured via the plugin. Trigger each opt-in capture (per-RPC
  span, sync session, bg/fg, memory checkpoint, storage size sample)
  with `captureApplicationData=true` and confirm presence; toggle off
  and confirm absence.
- Confirm no PII in events: open each event, scan for base64-shaped
  22-char strings, file paths under `Application Support`, project
  secrets.
- Confirm distributed trace shows JS-client span → backend RPC
  transaction → (with PR #1051) core operation spans.

### Regression

- Run the existing `e2e/run-instrumented-tests.sh` and the iOS
  `swift test` / `xcodebuild test` suite with `initSentry` _not_
  called → no behaviour change.

---

## Decisions and remaining questions

### Decided (carried forward)

| Question                              | Decision                                                                                                                                                                                                                                       |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sentry SDK versions                   | `@sentry/node@^8`, `@sentry/react-native@^7`, `@sentry/core@^9` (RN v7 re-exports it). OpenTelemetry-first majors so PR #1051 forwarding works without glue.                                                                                   |
| `release` source                      | Default to `versionName + "+" + versionCode` (Android) / `CFBundleShortVersionString + "+" + CFBundleVersion` (iOS). Successive EAS builds of the same marketing version produce distinct releases. Plugin override always wins.               |
| Boot transaction sample rate          | Force 100% even when overall `tracesSampleRate` is low. Boot is once-per-process and high-value.                                                                                                                                               |
| Bundle size strategy                  | Single bundle with rollup chunk-splitting — accept the disk cost. No dual-bundle build for v1.                                                                                                                                                  |
| Plugin behaviour with no `sentry` arg | No-op silently. Treat absent meta-data / plist keys as Sentry off. Used by `apps/example/`.                                                                                                                                                    |
| Sourcemap upload                      | Consumer responsibility. Module ships `*.map` in npm package; consumer excludes from APK/IPA and runs `sentry-cli sourcemaps upload` against `node_modules/.../nodejs-project/` in their own CI with their own credentials.                    |
| Toggle UI surface                     | Out of scope for this module. Module exposes `getDiagnosticsEnabled` / `setDiagnosticsEnabled` and `getCaptureApplicationData` / `setCaptureApplicationData` only; consumer builds the settings UI and the restart prompt.                     |
| Capture-application-data default      | Per-environment, decided by consumer at build time via `captureApplicationDataDefault` plugin field. EAS env var pattern: default to `true` when `environment !== "production"`. Once user flips the switch their explicit choice wins.        |
| Offline transport                     | Landed in Phase 10. Node envelopes are forwarded to the native side via the control socket; `sentry-android` / `sentry-cocoa` queue them under their existing offline-aware transports.                                                        |

### Still open

1. **Lazy chunk on iOS `--jitless`**: dynamic `import()` of a separate
   ESM chunk should work but isn't proven for our specific config.
   The Phase 3 smoke test exercises both with-Sentry and without-Sentry
   loader paths on iOS; re-verify on each `@sentry/react-native` /
   `@sentry/node` major bump. iOS is also the platform we already stub
   `@comapeo/core`'s maps plugin to keep undici out (see
   `backend/lib/maps-stub.js`); the Sentry chunk is an additional
   surface for this kind of iOS-only quirk.
2. **Cross-process scope on Android (re-verify on bumps)**: FGS-process
   Sentry events must carry `proc:fgs` and `@sentry/react-native`'s
   main-process tags must not override them in the dashboard.
   Verified in Phase 2b; re-verify when bumping
   `@sentry/react-native`'s sentry-android dep.

---

## Summary of file changes (remaining)

### Phase 4

- `backend/package.json` — bump `@comapeo/core` once PR #1051 ships.
- Smoke-test verification, no code changes expected.

### Phase 5

- `backend/lib/comapeo-rpc.js` — wire `tracesSampleRate` conditionally
  on the toggle; register sync-session emitter only when on.
- `backend/index.js` — gate memory-checkpoint timer and storage
  sampling on the toggle.
- `backend/before-send.js` (new) — `before_send` privacy processor
  (the §9b.1 scrubber wired in the backend; the JS side is wired in
  the next phase).
- `src/sentry.ts` — wire RN-side bg/fg breadcrumbs on
  `AppState.change` events.

### Phase 6

- `android/src/main/java/com/comapeo/core/ExitReasonsCollector.kt` (new)
- `android/src/main/java/com/comapeo/core/BackgroundAnchors.kt` (new)
- `android/src/main/java/com/comapeo/core/ExitReasonTags.kt` (new)
- `android/src/main/java/com/comapeo/core/SentryCategories.kt` — add
  `comapeo.exit`.
- `android/src/main/java/com/comapeo/core/ComapeoCoreApplicationLifecycleListener.kt` —
  schedule the collector on main-process boot.
- `android/.../ComapeoCoreService.kt` — schedule the collector on FGS
  boot; write `process_started_at_wall_ms` and
  `backgrounded_at_wall_ms` anchors.
- `expo-module.config.json` — register the
  `ApplicationLifecycleListener`.
- `android/src/test/java/com/comapeo/core/ExitReasonsCollectorTest.kt`,
  `ExitReasonTagsTest.kt` (new).

### Phase 7

- `ios/AppExitMetricsCollector.swift` (new).
- `ios/AppLifecycleDelegate.swift` — subscribe the collector on
  iOS 14+; skip on simulator if it complicates testing.
- `ios/SentryNativeBridge.swift` — add `captureExitBucketEvent(...)`
  helper for the per-event emission.
- `ios/SentryCategories.swift` — add `comapeo.exit`.
- `ios/Tests/AppExitMetricsCollectorTests.swift` (new).
- Phase 7b additional files:
  `ios/AppKillHeuristic.swift` (new),
  `ios/Tests/AppKillHeuristicTests.swift` (new).

### Phase 8

- `backend/rollup.config.ts` — if dual-bundle ships, emit a second
  bundle with the Sentry chunks stripped at build time, and
  `scripts/build-backend.ts` selects which to copy based on whether
  the consumer's `app.json` registered the plugin with a DSN.

### Phase 9b

- `src/sentry.ts` — replace the identity `beforeSend` placeholder
  with the substring scrubber; chain the URL-scrubbing
  `beforeBreadcrumb` from §9b.5.
- `backend/loader.mjs` — `Sentry.addEventProcessor` for the
  symmetric Node-side scrubber; move `consoleLoggingIntegration` to
  the app-usage-only branch (§9b.7).
- `backend/before-send.js` (new) — the shared scrubber
  implementation referenced by both `loader.mjs` and Phase 5's
  backend wiring.
- `android/.../ComapeoPrefs.kt`, `ios/ComapeoPrefs.swift` — add the
  `sentry.installationId` slot and the `user.id` derivation per
  tier.
- `android/.../ComapeoCoreService.kt`, `ios/AppLifecycleDelegate.swift`
  — pass the computed `userId` into `Sentry.setUser({ id })`.
- `backend/loader.mjs` — parse `--sentryUserId` and call
  `Sentry.setUser({ id })`.
- Phase 6 / Phase 7 collectors — gate the app-usage-tier tags on
  `captureApplicationData`.
- Setter paths (`setDiagnosticsEnabled`, `setCaptureApplicationData`)
  — reset Phase 6 anchors on toggle cycle (§9b.9).

### Phase 11

Renames (`captureApplicationData` → `applicationUsageData`) and new
`debug` toggle plumbing:

- `src/sentry.ts` — rename toggle accessors; add `get/setDebugEnabled`;
  derive `tracesSampleRate` from `debug` (not `applicationUsageData`).
- `src/ComapeoCoreModule.ts` — rename native bridge methods; split
  `onRequestHook` into always-on metric recording and debug-gated
  `Sentry.startSpan` block.
- `src/sentry-metrics.ts` (new) — RN-side `metrics.*` wrappers +
  `recordUsage.{screen, feature}` helpers; default-tag injection from
  `sentryConfig.deviceTags`.
- `app.plugin.js` — rename `captureApplicationDataDefault` →
  `applicationUsageDataDefault`; add `debugDefault`; deprecation
  warning on the old field for one minor.
- `android/.../ComapeoPrefs.kt`, `ios/ComapeoPrefs.swift` — rename
  pref key + one-shot migration of the old key; add `sentry.debug`
  and `sentry.debugEnabledAtMs` slots; implement the 24h auto-off
  in the debug reader (§11.5).
- `android/.../SentryConfig.kt`, `ios/SentryConfig.swift` — rename
  `captureApplicationDataDefault`; add `debugDefault` and
  `deviceTags`.
- `android/.../ComapeoCoreService.kt`, `ios/AppLifecycleDelegate.swift`
  — extend argv with `--applicationUsageData`, `--debug`,
  `--deviceClass`, `--osMajor`, `--platformTag`.
- `android/.../DeviceTags.kt` (new), `ios/DeviceTags.swift` (new) —
  device classification + OS-major computation.
- `backend/lib/sentry.js` — rename `captureApplicationData` argv
  field; add `debug` / `deviceClass` / `osMajor` / `platformTag`;
  `tracesSampleRate: argv.debug ? 1.0 : 0`; split `rpcHook` into
  always-on metric write + debug-gated span.
- `backend/lib/metrics.js` (new) — `Sentry.metrics.*` wrapper with
  default-tag injection and the `before_metric_send` defensive
  scrubber.
- `backend/lib/sentry-init.js` — re-export `Sentry.metrics` to
  `metrics.js`.
- `backend/index.js` — register periodic memory gauge timer; call
  `metrics.bootPhase` at each boot-span end; wire
  `metrics.stateTransition`.
- `backend/loader.mjs` — parse the new argv flags via the existing
  `sentry.argSpec`.
- `docs/sentry-integration.md` — rewrite §9 tier table to match
  Phase 11's three-toggle model; add §9.6 cross-link to this section.
- `docs/sentry-integration-history.md` — append Phase 11 entry on
  landing.

Tests added:

- `android/src/test/java/com/comapeo/core/DeviceTagsTest.kt`,
  `ios/Tests/DeviceTagsTests.swift` — classification boundary cases.
- `android/.../ComapeoPrefsMigrationTest.kt`,
  `ios/Tests/ComapeoPrefsMigrationTest.swift` — old-key → new-key
  one-shot migration.
- `backend/lib/metrics.test.mjs` (new) — default-tag injection,
  `before_metric_send` defensive scrubber, no-op when Sentry off.
- Extensions to `backend/lib/sentry.test.mjs` and
  `src/__tests__/sentry.test.js` for debug-on / debug-off branching.
