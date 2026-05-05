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

- **Module-side override hooks.** `@comapeo/core-react-native` exposes
  two paired overrides for non-production consumers:
  - `comapeoBackendDir` — Gradle property →
    `BuildConfig.COMAPEO_BACKEND_DIR` on Android; `ComapeoBackendDir`
    Info.plist key on iOS. Defaults to `nodejs-project` (the
    production bundle); `NodeJSService.kt` and
    `AppLifecycleDelegate.swift` read it to choose the bundle subdir.
  - `comapeoStubRootKey` — Gradle property →
    `BuildConfig.COMAPEO_STUB_ROOTKEY` on Android; `ComapeoStubRootKey`
    Info.plist key on iOS. Defaults to false. When true, the loader
    sends a 16-zero-byte stub on the init frame instead of touching
    the keystore/keychain. Required on devices without a configured
    screen lock (BrowserStack's stock fleet falls in this bucket —
    Android's super-encryption layer fails when
    `setUnlockedDeviceRequired(true)` meets a missing user ECDH
    key). Production consumers MUST leave this false.
- **Bench plugin.** `plugins/with-comapeo-bench/` is an Expo config
  plugin that (a) sets both overrides above, (b) copies the
  rolled-up bench bundle from `backend/dist/` into the consumer app's
  own native asset tree at prebuild time —
  `android/app/src/main/assets/nodejs-bench/` on Android, an Xcode
  folder reference under `<App>.app/nodejs-bench/` on iOS.
- **Bench backend.** `backend/index.js` reuses the production
  state machine (`pre-listening` → `started` → `ready`) and
  path-imports the framing helpers (`server-helper.js`,
  `simple-rpc.js`, `message-port.js`) from the module's production
  `backend/lib/` so the wire framing is bit-identical to production.
  `BenchRpcServer` (`backend/lib/bench-rpc.js`) registers only `echo`
  and `payload(sizeBytes)` methods. Telemetry sinks
  (`backend/lib/telemetry-sink.js`) are configurable via
  `--telemetry=<spec>` on argv: `noop` (default), `file:<path>`, or
  `http(s)://<url>`.
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
maestro test e2e/.maestro/bench-rpc.yaml             # all sizes
maestro test e2e/.maestro/bench-payload-64B.yaml
maestro test e2e/.maestro/bench-payload-1KB.yaml
maestro test e2e/.maestro/bench-payload-64KB.yaml
maestro test e2e/.maestro/bench-payload-1MB.yaml
```

Each flow launches the app, asserts `STARTED`, deselects unwanted
sizes, taps `send-button`, and asserts the `benchmark-result` panel
renders with the selected size label.

To target a specific simulator/emulator when several are booted:

```bash
maestro --device <udid-or-name> test e2e/.maestro/bench-rpc.yaml
```

## Sinks and the optional receiver

The on-device JSON file sink (Documents directory) is always written
and is the path of least resistance for ad-hoc local runs.

The **POST spans** UI toggle additionally fires each RPC span as a
fire-and-forget HTTP POST, default URL
`http://localhost:8787/spans`. This is intended for orchestrated
multi-device runs (see Phase 4 below) where a host-side receiver
collates spans across devices. Failures are silently logged so a
missing receiver never breaks the on-device flow.

## Phases

- ✅ **Phase 1–2:** shared sink + bench backend + dual-bundle build
  wiring (now: generic `comapeoBackendDir` override + bench-app config
  plugin).
- ✅ **Phase 3:** bench app UI, RPC bridge wiring, on-device
  p50/p95/p99 render, "Export results", config plugin, Maestro flows.
- 🛠 **Phase 4 (in progress):** BrowserStack App Automate — multi-device
  runs across representative Android + iOS hardware, with span
  aggregation via BrowserStack Local + a host-side receiver. See
  "Run on BrowserStack" below; results-format question still open.
- ⏳ **Phase 5:** `SentryAdapterSink` once the Sentry plan adopts the
  shared instrumentation; bench call sites stay the same.

## Run on BrowserStack

Three pieces wire together: the host-side **receiver** that collates
spans, the **BrowserStack Local** tunnel that lets the device reach
`localhost`, and the **runner script** that uploads the app + Maestro
flows and triggers a build.

### One-time setup

1. BrowserStack App Automate account with the Maestro framework
   enabled. Username + access key from `Account → Settings → Access
   Keys`.
2. Copy `.env.example` (repo root) to `.env` and fill in
   `BROWSERSTACK_USERNAME` / `BROWSERSTACK_ACCESS_KEY`.
3. Install the
   [BrowserStackLocal binary](https://www.browserstack.com/local-testing/app-automate#command-line)
   somewhere on `$PATH`.

### Per-run workflow

```bash
# 1. Receiver collates incoming spans → apps/benchmark/results/<runId>.ndjson
npm run bench:receiver

# 2. In another shell: tunnel localhost into the BS device fleet
BrowserStackLocal --key "$BROWSERSTACK_ACCESS_KEY" --daemon start
# (optional flags: --local-identifier, --force-local for offline-only)

# 3. Build a release APK and (Distribution-signed) IPA. Standard
#    Expo workflow — check expo docs for IPA signing.

# 4. Trigger the run (uploads app + Maestro flows, prints dashboard URL)
npm run bench:browserstack -- \
  --app-android path/to/release.apk \
  --app-ios path/to/release.ipa \
  --flow bench-rpc-receiver.yaml \
  --device-android "Samsung Galaxy S23 Ultra-13.0" \
  --device-ios "iPhone 15-17"

# 5. When done
BrowserStackLocal --key "$BROWSERSTACK_ACCESS_KEY" --daemon stop
```

The `bench-rpc-receiver.yaml` flow flips the bench app's "POST spans"
toggle before tapping run; spans land at
`http://localhost:8787/spans` and the receiver appends them to
`apps/benchmark/results/<runId>.ndjson`. Use `bench-rpc.yaml` instead
when you only want on-device results visible in the BrowserStack
dashboard.

The runner deduplicates app + test-suite uploads via `custom_id`, so
re-running with byte-identical artefacts is cheap.

## Repository layout

| Path | Role |
|---|---|
| `App.tsx` | Bench UI, RN-side RPC client |
| `app.json` | Registers the `with-comapeo-bench` plugin |
| `backend/index.js` | nodejs-mobile entry, control + comapeo socket bind |
| `backend/lib/bench-rpc.js` | `echo` / `payload(sizeBytes)` RPC dispatch |
| `backend/lib/boot-spans.js` | `boot.<phase>` span helper |
| `backend/lib/telemetry-sink.js` | `NoopSink` / `JsonFileSink` / `HttpSink` |
| `backend/rollup.config.js` | Single ESM bundle to `backend/dist/` |
| `plugins/with-comapeo-bench/` | Sets override + copies bundle into prebuild output |
