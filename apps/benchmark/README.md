# core-react-native-benchmark

Measures the `@comapeo/core-react-native` UDS / RPC bridge — boot
phases plus per-payload-size RPC round-trip latency — driving the
real RN→native→nodejs-mobile path with `@comapeo/core` stripped out
so framing / IPC / RPC regressions surface without core noise.

## What it measures

- **Boot phases.** `boot.listen-control`, `boot.init`, and
  `boot.construct` server-side spans, recorded via a configurable
  telemetry sink. (Three more native-side phases —
  `ipc-connect (control)`, `rootkey-load`, `ipc-connect (comapeo)` —
  will be added when the production loader adopts the same
  instrumentation.)
- **RPC round-trip latency** at four payload sizes (64 B / 1 KB /
  64 KB / 1 MB), 10 warmup + 100 steady-state iterations per size.
  RN-thread RTT is recorded per request alongside server-side handler
  duration so end-to-end vs. server-only timing can be diffed.

## How it's architected

The bench app drops a stripped backend bundle into the consumer app's
own native asset tree and tells the module's loader to read from
there. The module sees no bench-specific code:

- **Module-side override hook.** `@comapeo/core-react-native` exposes
  `comapeoEntryFile` for non-production consumers — Gradle property →
  `BuildConfig.COMAPEO_ENTRY_FILE` on Android; `ComapeoEntryFile`
  Info.plist key on iOS. Defaults to `index.mjs` (the production
  bundle's entry inside `nodejs-project/`); `NodeJSService.kt` and
  `AppLifecycleDelegate.swift` read it to choose the entry filename
  nodejs-mobile runs from `nodejs-project/`.
- **Bench plugin.** `plugins/with-comapeo-bench/` is an Expo config
  plugin that (a) sets the override above, (b) drops the
  rolled-up bench entry (`index.bench.mjs`) from `backend/dist/` into
  the consumer app's own `nodejs-project/` at prebuild time —
  `android/app/src/main/assets/nodejs-project/` (AGP merges with the
  library's `index.mjs`) on Android; on iOS the file is staged in
  `<projectName>/nodejs-bench-overlay/` and an Xcode Run Script build
  phase copies it into `<App>.app/nodejs-project/` after CocoaPods'
  resource-copy phase.
- **Bench backend.** `backend/index.js` reuses the production
  state machine (`pre-listening` → `started` → `ready`) and
  path-imports the framing helpers (`server-helper.js`,
  `simple-rpc.js`, `message-port.js`) from the module's production
  `backend/lib/` so the wire framing is bit-identical to production.
  `BenchRpcServer` (`backend/lib/bench-rpc.js`) registers `echo`,
  `payload(sizeBytes)`, and `ingestSpans` methods. Telemetry sinks
  (`backend/lib/telemetry-sink.js`) are configurable via
  `--telemetry=<spec>` on argv: `log` (default; one stdout line per
  span so logcat / device console captures them), `noop`, or
  `file:<path>`.
- **RN side.** `App.tsx` uses `unstable_messagePort` from
  `@comapeo/core-react-native` — a generic escape hatch one level
  below the public `comapeo` `MapeoClient` — to send raw frames over
  the same JSI → native UDS path real users hit. The bench-specific
  request/response schema (`{id, method, params}` vs production's
  `{id, jsonrpc, ...}`) means the production RPC machinery treats
  bench frames as unknown and ignores them.

```
React Native (App.tsx)
     │  postMessage({ id, method, params })
     ▼
unstable_messagePort  ←  @comapeo/core-react-native
     │
     ▼
JSI bridge → native module → Unix-domain socket pair
     │
     ▼
nodejs-mobile (backend/index.js)
     │
     ▼
BenchRpcServer.dispatch → echo / payload(sizeBytes)
```

## Run it

Prerequisites: Xcode (for iOS) / Android SDK, Node 24, an
iOS simulator or Android emulator booted.

```bash
cd apps/benchmark
npm install
npm run ios            # or:  npm run android
```

Each platform script runs `prebuild:bundle` first (installs bench
backend deps + rolls up `dist/index.mjs`) and then invokes
`expo run:<platform>`. After the app launches, wait for
`Backend → state` to read **STARTED**, optionally toggle payload
sizes, then tap **Run benchmark**.

Per-size p50 / p95 / p99 render on screen. The full per-RPC NDJSON
is written to the app's Documents directory; tap **Export results**
to share via the system share sheet (iOS) or reveal the path
(Android).

If you've previously generated `android/` or `ios/` and want a clean
prebuild:

```bash
rm -rf android ios && npm run prebuild
```

## Maestro flows

```bash
maestro test apps/benchmark/.maestro/bench-rpc.yaml              # all sizes
maestro test apps/benchmark/.maestro/bench-payload-64B.yaml
maestro test apps/benchmark/.maestro/bench-payload-1KB.yaml
maestro test apps/benchmark/.maestro/bench-payload-64KB.yaml
maestro test apps/benchmark/.maestro/bench-payload-1MB.yaml
```

Each flow launches the app, asserts `STARTED`, taps `send-button`,
and asserts the `benchmark-result` panel renders. The `config.yaml`
in the same directory constrains Maestro CLI to the `bench-*.yaml`
discoveries.

To target a specific simulator/emulator when several are booted:

```bash
maestro --device <udid-or-name> test apps/benchmark/.maestro/bench-rpc.yaml
```

## Span transport: logcat

Per-RPC spans are emitted as `BENCH_SPAN <json>` lines on `console.log`
— from RN's bridge (App.tsx) and from nodejs-mobile (the bench
backend's default `LogSink`). Both surface in Android `logcat` (under
their respective tags) and iOS device console.

For local standalone runs, watch them with:

```bash
adb logcat | grep BENCH_SPAN
```

Or rely on the on-device `JsonFileSink` that writes the same data to
`<app sandbox>/Documents/comapeo-bench/<runId>.ndjson` — exportable
via the **Export results** button in the UI.

For BrowserStack runs, `scripts/run-on-browserstack.ts` pulls each
device's logcat after the build finishes, greps `BENCH_SPAN` lines,
and writes one NDJSON file per device into
`apps/benchmark/results/`. No tunnel, no receiver. (See "Run on
BrowserStack" below.)

## Phases

- ✅ **Phase 1–2:** shared sink + bench backend + dual-bundle build
  wiring (now: generic `comapeoEntryFile` override + bench-app config
  plugin).
- ✅ **Phase 3:** bench app UI, RPC bridge wiring, on-device
  p50/p95/p99 render, "Export results", config plugin, Maestro flows.
- ✅ **Phase 4:** BrowserStack App Automate — log-based span pull
  across a curated 10-device sweep, auto-batched against plan
  capacity, Test R&A integration via `customBuildName` +
  `buildIdentifier`.
- ⏳ **Phase 5:** `SentryAdapterSink` once the Sentry plan adopts the
  shared instrumentation; bench call sites stay the same.

## Run on BrowserStack

### One-time setup

1. BrowserStack App Automate account, RBAC role with `create:build`
   permission. Username + access key from `Account → Settings →
   Access Keys`.
2. Copy `.env.example` (repo root) to `.env` and fill in
   `BROWSERSTACK_USERNAME` / `BROWSERSTACK_ACCESS_KEY`. If your
   account can't auto-create projects, also set
   `BENCH_BROWSERSTACK_PROJECT` to an existing project name.

### Per-run workflow

```bash
# 1a. Android: build a release APK with the JS bundle embedded.
cd apps/benchmark
npm run prebuild:bundle
cd android && ./gradlew :app:assembleRelease
cd ../../..

# 1b. iOS: build a Development-export IPA. Requires
#     APPLE_DEVELOPMENT_TEAM_ID in .env (10-char team id) and the
#     bundle id com.comapeo.core.benchmark registered in your team's
#     Identifiers. BrowserStack auto-resigns on upload, so a
#     Development export (not Distribution / App Store) is enough.
cd apps/benchmark && npm run ios:archive && cd ../..

# 2. Dispatch — defaults to the curated 10-device Android sweep,
#    auto-batches against plan capacity (5+5 → fits in one build).
npm run bench:browserstack -- \
  --app-android apps/benchmark/android/app/build/outputs/apk/release/app-release.apk \
  --app-ios apps/benchmark/ios-build/ipa/corereactnativebenchmark.ipa
# Optional flags:
#   --devices-android "<csv>"   override Android device list
#   --devices-ios "<csv>"       override iOS device list
#   --build-tag <label>         filter on dashboard
#   --build-identifier <id>     per-run id (defaults to ISO timestamp)

# 3. Refresh RESULTS.md from the pulled NDJSONs
npm run bench:summarize
```

The script:
- queries `/plan.json` for the parallel + queued cap,
- chunks the device list into builds that fit,
- dispatches each, polls until terminal, pulls per-device logcat,
- greps `BENCH_SPAN` lines into one NDJSON per device under
  `apps/benchmark/results/`.

No `BrowserStackLocal` tunnel needed; no receiver process; no
`local: true` on the trigger payload.

## Repository layout

| Path | Role |
|---|---|
| `App.tsx` | Bench UI, RN-side RPC client (`console.log("BENCH_SPAN ...")`) |
| `app.json` | Registers the `with-comapeo-bench` plugin |
| `.maestro/` | Maestro flows + workspace `config.yaml` |
| `backend/index.js` | nodejs-mobile entry, control + comapeo socket bind |
| `backend/lib/bench-rpc.js` | `echo` / `payload(sizeBytes)` RPC dispatch |
| `backend/lib/boot-spans.js` | `boot.<phase>` span helper |
| `backend/lib/telemetry-sink.js` | `LogSink` (default) / `JsonFileSink` / `NoopSink` |
| `backend/rollup.config.js` | Single ESM bundle to `backend/dist/` |
| `plugins/with-comapeo-bench/` | Sets module override + copies bundle into prebuild output |
