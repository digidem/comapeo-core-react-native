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
| Phase 7b — iOS killed-in-background heuristic (optional)                   | `UserDefaults`-anchored per-event "killed in background" inference layered on top of the landed Phase 7a MetricKit forwarding (which is 24h-aggregate only).                                                                                                                                   |
| Phase 8 — refinements                                                      | Sample-rate tuning from real data; optional dual-bundle if size matters.                                                                                                                                                                                                                       |
| Phase 9b — PII scrubber, user.id rotation, context reclassification        | Scrubber (9b.1), user.id rotation (9b.2), network-URL scrubbing (9b.5), and consoleIntegration gating (9b.7, now debug-gated) landed with the Phase 11 branch; native-scope field split (9b.3), boot-transaction slimming (9b.4), and backend free-mem refresh (9b.6) landed with issue #79; toggle anchor resets (9b.9) landed separately. Phase 9b complete. |
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
**captures the toggle gates**.

Several items originally specced here have been re-tiered to
**metrics at diagnostic** (Phase 11) since the SDK v8 migration made
Application Metrics available on every layer. The privacy rationale:
metrics are aggregate, low-cardinality, and carry no per-user timeline
or free-text payloads, so they don't need the usage opt-in that
per-event captures do. Specifically:

- ~~Per-RPC client + server spans~~ — superseded by §11.3: RPC *timing*
  is a `comapeo.rpc.*.duration_ms` distribution metric at diagnostic;
  per-RPC *traces* move behind the `debug` toggle.
- ~~Backend memory checkpoint~~ — superseded by §11.2's
  `comapeo.backend.memory_rss_bytes` / `heap_used_bytes` gauges at
  diagnostic (device-health, not user behaviour).
- ~~`privateStorageDir` size sample~~ — superseded by a bucketed
  diagnostic-tier counter in §11.2's inventory; the bucketing
  (`<10MB`, `10–100MB`, `100MB–1GB`, `>1GB`) that made it safe as an
  event makes it safe as a metric tag.

What genuinely remains usage-tier (per-event, session-shape data):

- **Sync session lifecycle transaction.** A `comapeo.sync.session`
  transaction from `connectPeers` (or first peer-connected event) through
  to `syncFinished`/`disconnect`. Spans inside for `discover`, `handshake`,
  `replicate`. Counts only: number of peers (bucketed), bytes transferred
  (bucketed), duration. **No peer identities, no project IDs in raw form.**
- **Background/foreground transitions** — host-app `pause` and `resume`
  events become `comapeo.app.background` / `comapeo.app.foreground`
  breadcrumbs that ride on subsequent events, helping correlate timing
  ("error fired 3s after app backgrounded").
- **`before_send` privacy processor** — see Phase 9b for the full design;
  Phase 5 lands the wiring in `backend/before-send.js` so the captures
  above are scrubbed before they leave Node.

Cost: ~100 LOC native + JS + backend.

---

## Phase 7b — iOS killed-in-background heuristic (optional)

Phase 6 (Android exit reasons) and Phase 7a (iOS MetricKit app-exit
forwarding) have landed — see `sentry-integration.md` §7.5 for the
as-built design. What remains from the original Phase 7 spec is the
optional 7b sub-phase.

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
  (Phase 7a) and sentry-cocoa's crash reporter help disambiguate
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

### 7b.1 Tests

- `AppKillHeuristicTests.swift`: mock `UserDefaults` + a clock; assert:
  - Clean termination marker prevents the next-launch inference.
  - Stale marker fires once and is then cleared.
  - Foreground vs background marker drives `ios.killed_in_background`
    correctly.

Manual verification: a jetsam test (`/usr/bin/MemoryLogger` or the
Xcode "Simulate Memory Warning" → background → kill flow).

### 7b.2 Out of scope (platform limitations, unchanged from Phase 7)

- Per-event timestamps for `MXAppExitMetric`. Apple doesn't expose them.
- Background-task-budget instrumentation (how close to the ~30s
  assertion expiry were we when iOS suspended us?). Worth a separate
  small phase if `background_task_assertion_timeout` shows up
  frequently in the dashboard.

Cost: ~80 LOC Swift + ~50 LOC tests.

---

## Phase 8 — refinements

- Tune sample rates from production data.
- ~~Migrate exit telemetry (Phases 6/7a) from events to Sentry
  Application Metrics~~ — **landed** with the @sentry/react-native v8
  migration (sentry-android 8.43, sentry-cocoa 9.15): both platforms now
  emit `comapeo.app.exit` counts, see `docs/sentry-integration.md` §7.5.
  Archive any exit-event issues left over from the events era in the
  Sentry UI.
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

### 9b.2 `user.id` — root user ID + monthly rotation

**Landed** (with the Phase 11 branch) — see
[`sentry-integration.md` §9.2](./sentry-integration.md#92-the-applicationusagedata-toggle)
"Sentry `user.id`" for the as-built design. Two deltas from this
section's original spec:

- The stored ID is named **`sentry.rootUserId`** and is *never* sent
  raw. The usage tier uses `sha256(root + "|permanent")` instead of the
  raw ID, so the root ID is only ever shared by explicit user action
  (via the `getRootUserId()` API, for support cases).
- Both tiers hash with the same shape:
  `sha256("<root>|<salt>").slice(0, 16)` where salt is UTC `YYYY-MM`
  (diagnostic, monthly rotation) or `"permanent"` (usage opt-in).

Distribution matches the spec: native derives once per process start,
exposes `userId` on the `sentryConfig` Expo constant, passes
`--sentryUserId` argv to the backend, and all three SDKs set the same
`user.id`.

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

- **Error/fatal events are exempt**: full device context is most valuable
  exactly when something crashed, so error and fatal captures keep the SDK's
  complete `device`/`os`/`app` scope at both tiers. Only `culture` (locale +
  timezone) is still dropped from them at the diagnostic tier. The allowlist
  below applies to transactions and non-error events.
- **Diagnostic tier emits** (non-error events):
  - `device`: `manufacturer`, `brand`, `model`, `model_id`, `family`,
    `arch`, `simulator`, `processor_count`, `memory_size`,
    `storage_size` (bucketed to standard sizes:
    8/16/32/64/128/256/512/1024 GB).
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

**Done** — landed with the Phase 6/7 implementation rather than
deferred here. The duration-derived fields (`bg_duration_bucket`,
`uptime_bucket`, `comapeo.fgs.killed_in_background`, exact-duration
extras) and the iOS per-event multiplication only flow when
capture-application-data is on; the exit records themselves ship at
diagnostic. See `sentry-integration.md` §7.5.

### 9b.9 Phase 6 timestamp anchor reset on toggle cycle

**Done.** When `diagnosticsEnabled` or `applicationUsageData` flips
`false → true`, the setter resets the exit-telemetry anchors to "now"
so records generated during the "off" window are never surfaced on
re-enable. Android: `BackgroundAnchors.resetExitTelemetryAnchors` — the
per-process high-water marks plus the duration anchors
(`process_started_at`, main's `foregrounded_at`). iOS: `ComapeoPrefs`
stamps `sentry.exitTelemetryResetAtMs`; `AppExitMetricsCollector`
drops MetricKit windows that began before the stamp (a 24h aggregate
can't be split, so an overlapping window is dropped whole). Only an
off → on transition resets — redundant sets and disables leave the
anchors alone. See `sentry-integration.md` §7.5.

---

## Phase 11 — Metrics-first observability + `debug` tier

Shift day-to-day performance signal from per-RPC tracing to **Sentry
Application Metrics** ([product docs](https://docs.sentry.io/product/explore/metrics/)),
keeping tracing as an investigation-only mode behind a new user-facing
`debug` toggle. Rename `captureApplicationData` → `applicationUsageData`
with refined semantics (stable `user.id` + usage events, no longer perf
tracing).

**Unblocked.** The SDK v8 migration brought the metrics API to every
layer: `@sentry/react-native` 8.x (JS), sentry-android 8.43 (Kotlin),
sentry-cocoa 9.15 (Swift), `@sentry/node-core` 10.53 (backend). The
first metrics consumer — `comapeo.app.exit` from the Phase 6/7a exit
collectors — already emits from the native layers, so the pipeline is
proven; this phase is "more of the same" plus the toggle rework.

The tier rationale, stated once: metrics are **aggregate and
low-cardinality** — pre-bucketed tags, no per-user timeline, no
free-text payloads — so they sit at the always-on diagnostic tier
where per-event equivalents would have needed the usage opt-in.
Traces (a precise per-operation timeline) are the privacy-expensive
shape, which is why they move behind `debug`.

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
`Sentry.metrics.count(...)` / `Sentry.metrics.gauge(...)` from
`@sentry/node-core` v10 (Node) and `@sentry/react-native` v8 (RN);
native call sites use `Sentry.metrics()` (Kotlin) and
`SentrySDK.metrics` (Swift) — see `ExitReasonsCollector.kt` /
`SentryNativeBridge.countMetric` for the landed pattern. Backend
envelopes ride the existing forwarding transport
(`backend/lib/sentry.js` `forwardingTransport`) — same DSN, same
control-socket → native sink, same offline-aware native queue. No new
pipeline.

Tags follow strict low-cardinality rules (see §11.8). One **default
tag** is attached by `metrics.js` to every emission so we can never
forget it at the call site:

- `platform` (`ios` / `android`)

Device tags (`device_class`, `os_major`) ride **only on the
`.by_device` mirror metrics**, not on every metric. Sticking them on
every emission would multiply cardinality by ~30× on the per-method
metrics (see §11.2.c) and the mirror metric exists precisely so the
primary metric can stay narrow.

#### 11.2.a Metric inventory

The primary metric in each pair carries per-method (or per-phase)
detail for "which operation is slow"; the `.by_device` mirror drops
the question-specific dimension and carries device tags instead, so
the per-method × per-device join doesn't materialise as one bloated
metric. Same call site emits both with one helper call.

| Metric                                       | Type         | Tags                                                                                                       | Source                              |
| -------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `comapeo.rpc.server.duration_ms`             | distribution | `method`, `status`, `platform`                                                                             | `backend/lib/sentry.js` `rpcHook`   |
| `comapeo.rpc.server.duration_ms.by_device`   | distribution | `status`, `platform`, `device_class`, `os_major`                                                           | same call site                      |
| `comapeo.rpc.server.errors`                  | counter      | `method`, `error_class`, `platform`                                                                        | server hook on catch                |
| `comapeo.rpc.client.duration_ms`             | distribution | `method`, `status`, `platform`                                                                             | `src/ComapeoCoreModule.ts` hook     |
| `comapeo.rpc.client.duration_ms.by_device`   | distribution | `status`, `platform`, `device_class`, `os_major`                                                           | same call site                      |
| `comapeo.rpc.client.send_ms`                 | distribution | `method`, `platform`                                                                                       | existing `rn.send.syncMs` measurement |
| `comapeo.boot.phase_duration_ms`             | distribution | `phase` (`fgs-launch`, `extract-assets`, `node-spawn`, `loader-init`, `manager-init`, `rootkey-load`), `platform` | each boot-span `end()`              |
| `comapeo.boot.phase_duration_ms.by_device`   | distribution | `phase`, `platform`, `device_class`, `os_major`                                                            | same call site                      |
| `comapeo.boot.outcome`                       | counter      | `outcome` (`started` / `error`), `error_phase?`, `platform`                                                | `STARTED` / ERROR transition        |
| `comapeo.sync.session.duration_ms`           | distribution | `outcome`, `platform`                                                                                      | sync session end                    |
| `comapeo.sync.session.duration_ms.by_device` | distribution | `outcome`, `platform`, `device_class`, `os_major`                                                          | same call site                      |
| `comapeo.sync.session.peers_bucket`          | counter      | `bucket` (`1-3` / `4-10` / `10+`), `platform`                                                              | session start                       |
| `comapeo.sync.bytes_bucket`                  | counter      | `bucket` (`<1M` / `1-10M` / `10-100M` / `100M+`), `platform`                                               | session end                         |
| `comapeo.backend.memory_rss_bytes`           | gauge        | `platform`                                                                                                 | 60s timer in `backend/index.js`     |
| `comapeo.backend.heap_used_bytes`            | gauge        | `platform`                                                                                                 | same timer                          |
| `comapeo.fgs.uptime_s`                       | gauge        | `platform`                                                                                                 | same timer                          |
| `comapeo.state.transitions`                  | counter      | `from`, `to`, `platform`                                                                                   | every `stateChange`                 |
| `comapeo.storage.size_bucket`                | counter      | `bucket` (`<10MB` / `10-100MB` / `100MB-1GB` / `>1GB`), `platform`                                         | once at `STARTED` (ex-Phase 5 item) |
| `comapeo.app.exit` *(landed)*                | counter      | see `sentry-integration.md` §7.5 — reason/bucket/severity/cohort attributes                                 | exit collectors (Phases 6/7a)       |

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

**Worked example, why we split.** Take `rpc.server.duration_ms` with
the worst-case tag bag (the old "everything on every metric" design,
preserved here as the counter-example):

| Dimension                       | Count        | Notes                                                                                                                          |
| ------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `method`                        | ~50–80       | full `@comapeo/core` IPC surface; includes namespaced methods                                                                  |
| `status`                        | 3            | `ok` / `error` / `timeout`                                                                                                     |
| `platform`                      | 2            |                                                                                                                                |
| `os_major`                      | 5 ios + 6 android = ~11 valid platform+os pairs | not 20 — `(ios, android.13)` can't co-occur, so the **joint** is the sum, not the product |
| `device_class`                  | 3            |                                                                                                                                |
| `release` (Sentry auto-tag)     | 3–5 active   | distinct releases in active install base                                                                                       |
| `environment` (Sentry auto-tag) | 1–3          | usually `prod` plus internal/qa                                                                                                |

Cartesian, middle values: 70 × 3 × 11 × 3 × 4 × 2 = **~55k series**
for that one metric. Even discounting `release` and `environment`
(if Sentry's billing indexes them separately, which is the optimistic
read): 70 × 3 × 11 × 3 = **6.9k base series** per metric — and with
five RPC-shaped metrics that path lands well past Sentry's 10k-per-
metric guidance the moment two of them run side-by-side.

**The split fixes it.** With device tags moved off the primary
metrics and onto the `.by_device` mirrors, no single metric carries
all the dimensions:

| Metric                                       | Tags                                              | Series (base × release-env)                         |
| -------------------------------------------- | ------------------------------------------------- | --------------------------------------------------- |
| `rpc.server.duration_ms`                     | method × status × platform                        | 70 × 3 × 2 = **420** (× 12 ≈ 5,040 worst-case)      |
| `rpc.server.duration_ms.by_device`           | status × platform × device_class × os_major       | 3 × 11 × 3 = **99** (× 12 ≈ 1,188)                  |
| `rpc.server.errors`                          | method × error_class × platform                   | 70 × 5 × 2 = **700** (× 12 ≈ 8,400)                 |
| `rpc.client.duration_ms`                     | method × status × platform                        | 420 (× 12 ≈ 5,040)                                  |
| `rpc.client.duration_ms.by_device`           | status × platform × device_class × os_major       | 99 (× 12 ≈ 1,188)                                   |
| `rpc.client.send_ms`                         | method × platform                                 | 140 (× 12 ≈ 1,680)                                  |
| `boot.phase_duration_ms`                     | phase × platform                                  | 12 (× 12 ≈ 144)                                     |
| `boot.phase_duration_ms.by_device`           | phase × platform × device_class × os_major        | 198 (× 12 ≈ 2,376)                                  |
| `boot.outcome`                               | outcome × error_phase × platform                  | ≈ 24 (× 12 ≈ 288)                                   |
| `sync.session.duration_ms`                   | outcome × platform                                | 6 (× 12 ≈ 72)                                       |
| `sync.session.duration_ms.by_device`         | outcome × platform × device_class × os_major      | 99 (× 12 ≈ 1,188)                                   |
| `sync.session.peers_bucket`                  | bucket × platform                                 | 6 (× 12 ≈ 72)                                       |
| `sync.bytes_bucket`                          | bucket × platform                                 | 8 (× 12 ≈ 96)                                       |
| `backend.memory_rss_bytes`                   | platform                                          | 2 (× 12 ≈ 24)                                       |
| `backend.heap_used_bytes`                    | platform                                          | 2                                                   |
| `fgs.uptime_s`                               | platform                                          | 2                                                   |
| `state.transitions`                          | from × to × platform                              | 25 × 2 = **50** (× 12 ≈ 600)                        |

No metric over 10k even at the worst case where `release` and
`environment` count toward the budget (which is conservative — Sentry's
docs aren't explicit but historical behaviour was to index those
separately from user-defined tags). Most metrics under 2k.

**Open question on auto-tags.** Worth confirming with Sentry support
or empirical testing before landing whether `release` and `environment`
count toward the per-metric series limit. If they do, the table above
is the budget we live within. If they don't, we have ~10× more
headroom than this table suggests.

#### 11.2.d Why bucketed device tags, not raw

Two practical pitfalls if we tagged with raw `device.model`:

1. **Cardinality cost** — ~2,000 Android model strings × 80 methods ×
   3 status × ~6 Android-major = ~3M series for one metric on Android
   alone. Unaffordable on any Sentry plan and unusable on dashboards.
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
   in Phase 9b.2. Locks to the permanent hash of the root user ID
   (never the raw ID). Without `applicationUsageData` the user.id
   rotates monthly across diagnostic captures (cohort-unlinkable).
   With it on, stable across launches and months (cohort analysis
   works).
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
  - Internal `defaultTags = { platform }` (the only one cheap enough
    to attach to every metric — see §11.2.c). `device_class` and
    `os_major` are passed explicitly only to the `.by_device`
    helpers, so the cardinality split is enforced at the API
    boundary, not at the call site.
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
  shape (platform only); device tags supplied explicitly to
  `.by_device` helpers, read from `sentryConfig.deviceTags`.

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

#### Allowed default tags (auto-attached by `metrics.js` to every metric)

- `platform`: 2 values

#### Tags allowed on `.by_device` mirror metrics only

These multiply cardinality enough that they don't ride on every
metric — only on the explicit `.by_device` variants that drop the
question-specific dimension in exchange.

- `device_class`: 3 values
- `os_major`: ~5–6 values per platform (so the joint with `platform`
  is ~11 valid pairs, not 20)

#### Allowed per-metric tags

- `method`: small enum (~50–80 RPC methods across the full `@comapeo/core` IPC surface)
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
- **Regression**: existing `scripts/run-instrumented-tests.sh` + Swift /
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

- Run the existing `scripts/run-instrumented-tests.sh` and the iOS
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
| Plugin behaviour with no `sentry` arg | No-op silently. Treat absent meta-data / plist keys as Sentry off. Used by `apps/integration/`.                                                                                                                                                    |
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
