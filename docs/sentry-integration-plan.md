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
