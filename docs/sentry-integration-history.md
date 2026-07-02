# Sentry Integration — Landed Work

Historical record of the Sentry integration phases that have already shipped on
`main`. Frozen as of 2026-05-15. For the architecture as it stands today see
[`sentry-integration.md`](./sentry-integration.md); for the work that's still
ahead see [`sentry-integration-plan.md`](./sentry-integration-plan.md).

## Status snapshot

| Phase                                                                      | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase 1 — JS adapter                                                       | `src/sentry.ts` + `src/sentry-internal.ts`; auto-detects `@sentry/react-native` at import time, no explicit handoff call.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Phase 2a — plugin + native readers                                         | `app.plugin.js`; `SentryConfig.{kt,swift}` + tests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Phase 2b — Android FGS native captures                                     | `SentryFgsBridge.kt` + bridge wired into `ComapeoCoreService` and `NodeJSService`; 9 JVM tests. iOS Phase 2b not needed (single-process app — JS adapter covers it).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Phase 3 — backend loader + RPC tracing                                     | `backend/loader.mjs` spawn target; `@sentry/node` + `import-in-the-middle` + multi-entry rollup with `importHook` / `lib/register` separate chunks; `handleFatal` captures via Sentry; `ComapeoRpcServer` registers `onRequestHook` when Sentry is active; client-side `ComapeoCoreModule.ts` propagates `sentry-trace`/`baggage` via request metadata. Native (Android `NodeJSService.kt` / iOS `NodeJSService.swift`) reads `SentryConfig` and forwards `--sentry*` argv flags to the loader.                                                                                                                                                          |
| Phase 9a — `diagnosticsEnabled` + module ownership of `Sentry.init`        | New `diagnosticsEnabled` pref alongside `captureApplicationData`. Module owns `Sentry.init` via `initSentry()`. Cheap fix: free memory/disk attached to backend `handleFatal`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Phase 10 — offline transport via control-socket forwarding                 | Custom `@sentry/node` transport in `loader.mjs` inspects each envelope and routes single-item error events as `{type:"sentry-event",payload}` (decoded via `SentryEventDecoder` / `SentryEvent.Deserializer` and captured via `Sentry.captureEvent`, with native scope merged), and everything else as `{type:"sentry-envelope",data}` (passed via `InternalSentrySdk.captureEnvelope` / `PrivateSentrySDKOnly.captureEnvelope`). Two 100-frame ring buffers (loader + `SimpleRpcServer`) cover the boot-sequence gaps. `SentryNativeContext.{kt,swift}` and the `sentryContext`-in-init-frame flow removed (native applies its own scope at capture). |
| Phase 6 — Android historical exit reasons                                  | `ExitReasonsCollector.kt` surfaces `getHistoricalProcessExitReasons` records (API 30+) as `"android exit: REASON_*"` events on next process start, from both the main process (`ComapeoCoreApplicationLifecycleListener`) and the FGS (`ComapeoCoreService.onCreate`). `oem.killer.suspected` flags SIGKILL-to-foreground-service deaths; wall-clock anchors in `BackgroundAnchors.kt` derive uptime/backgrounded-for buckets (app-usage tier only, per §9b.8).                                                                                                                                                                                          |
| Phase 7a — iOS MetricKit app-exit forwarding                               | `AppExitMetricsCollector.swift` subscribes to `MXMetricPayload` (the metric side sentry-cocoa skips) and forwards `MXAppExitMetric` buckets as `"ios exit: <cohort>_<bucket>"` events; per-exit duplication at app-usage tier, collapsed to one event per window+bucket at diagnostic. Optional 7b heuristic remains in the plan.                                                                                                                                                                                                                                                                                                                       |
| SDK v8 + Application Metrics migration                                      | `@sentry/react-native` ^7.13 → ^8.13 (peer-dep major), sentry-cocoa 8.58 → 9.15 (`HybridSDK` subspec dropped — plain `Sentry` pod), sentry-android 8.32 → 8.43. Exit telemetry re-emitted as `comapeo.app.exit` count metrics (no issue lifecycle, no iOS per-event duplication); coarse duration buckets re-tiered to diagnostic, exact ms durations stay usage-tier.                                                                                                            |

## Divergences from the original plan

Implementation evolved past the original plan in several places:

- The `SentryFgsBridge` / `SentryFgsBridgeImpl` guard / impl split was reverted
  — both halves live in a single `SentryFgsBridge.kt` since the classpath probe
  is no longer needed. `@sentry/react-native` is now a non-optional peer
  dependency of this module, so the build-time gating (Android `Class.forName`
  classpath probe, iOS `#if canImport(Sentry)` conditionals, JS adapter shim,
  hand-rolled `SentryAdapter` interface) was removed.
- On iOS, `Sentry/HybridSDK` is now a hard CocoaPods dep of this module's
  podspec **and** Sentry-Cocoa is a hard SPM dep of `ios/Package.swift`, pinned
  to the same version in both places (enforced by
  `scripts/check-sentry-cocoa-pin.mjs`).
- RPC span ops follow OpenTelemetry's RPC semantic conventions:
  `op: rpc.client` on the RN side and `op: rpc.server` on the backend (not
  `op: "ipc"` as in earlier drafts). Both carry `rpc.system: "comapeo-ipc"`
  and `rpc.method: <name>` attributes.
- The RN-side `onRequestHook` no longer short-circuits when no parent span is
  active: it gates on `Sentry.isInitialized()` and uses `startNewTrace` to mint
  a fresh `trace_id` per call when no caller transaction exists.
- iOS sentry-cocoa is initialised natively in
  `AppLifecycleDelegate.application(_:didFinishLaunchingWithOptions:)` —
  parallel to Android's `ComapeoCoreService.onCreate`. JS-side `Sentry.init`
  runs with `autoInitializeNativeSdk: false` so the native hub is the single
  owner of the SDK lifecycle.
- `backend/lib/sentry-instrument.js` was renamed to `backend/lib/sentry.js` and
  `bootPhase` was split into `withPhase` (Sentry-agnostic phase tag) +
  `withSpan` (Sentry-only).
- The runtime gating still applies: when the Expo plugin is registered without
  a `sentry` argument, no DSN is baked into the native config and
  `initSentry()` returns early — Sentry is installed but inert.

## Phase 1 — JS-side error capture (smallest delivery)

- `@sentry/react-native` is auto-detected at module load (require-then-catch);
  no explicit handoff call. `setSentryAdapterForTests(adapter | null)` is
  exported for test injection only.
- `state` listeners capture ERROR transitions and `messageerror` events via
  `@sentry/react-native`.
- Shipped as `@comapeo/core-react-native/sentry` sub-export.
- Host app (CoMapeo Mobile) calls `Sentry.init` itself.

Value: immediate visibility into rootkey failures, watchdog timeouts, IPC
errors, and `messageerror` parse failures — provided RN is alive when they
fire. (The FGS-cold-start gap is closed in Phase 2.)

Cost: ~50 LOC in `src/sentry.ts`, no native or backend changes.

## Phase 2a — Expo config plugin + native config readers

- New `app.plugin.js` at module root.
- iOS reads Info.plist into `SentryConfig` at load time; Android reads manifest
  meta-data into `SentryConfig`.
- JVM unit tests + Swift `XCTest` cases pinning the parsers' contract
  (DSN-absent → null, missing environment → throw, versionName/versionCode
  default release, numeric coercion, strict bool parsing).
- JS-side state-transition breadcrumbs + ERROR `captureException` fire through
  the configured adapter immediately. The plugin makes the host app's manifest
  carry the same DSN/environment values `@sentry/react-native` reads, so the
  host-supplied adapter is correctly tagged.

Cost: ~150 LOC plugin + Kotlin + Swift + tests.

## Phase 2b — FGS-process direct Sentry calls (Android only)

iOS doesn't need a Phase 2b — it's a single-process app and the host's
`@sentry/react-native` already covers everything the JS adapter forwards.
Phase 2b is Android-specific.

Shipped:

- `io.sentry:sentry-android-core:8.32.0` added to `android/build.gradle`. The
  runtime classes come transitively from `@sentry/react-native@^7` (which
  ships sentry-android 8.32.x — first line that has the structured-log API
  the bridge calls). Bumping should be done in lock-step with the RN peer-dep
  range.
- `SentryFgsBridge.kt` — single-file bridge (the original guard/impl split was
  reverted since `@sentry/react-native` is now a non-optional peer dep).
- FGS-side `SentryAndroid.init` in `ComapeoCoreService.onCreate`. Sets
  `proc:fgs` and `layer:native` as process-level tags so dashboards split FGS
  captures from main-process captures (which carry `proc:main` from
  `src/sentry.ts`).
- State-transition breadcrumbs on every `applyAndEmit` transition.
- `comapeo.boot` transaction opened in `start()`, closed on first STARTED
  (`ok`) / ERROR (`internal_error`). In-flight phase spans are closed on the
  same terminal.
- `boot.rootkey-load` span around `RootKeyStore.loadOrInitialize()`. The
  init-frame round-trip is marked by a breadcrumb pair (`"init frame sent"` +
  control `"received: ready"`); the duration is dominated by Node-side
  `boot.manager-init`, which already carries finer error attribution.
- Timeout events: `comapeo: startup timeout fired` (level=error,
  `timeout:startup`), `comapeo: FGS stop timeout fired` (level=error,
  `timeout:fgsStop`).
- Control-frame breadcrumbs: `received: started`, `received: ready`,
  `received: stopping`, `received: error`, `malformed control frame`. Plus
  FGS lifecycle breadcrumbs: `ComapeoCoreService.onCreate`, `onStartCommand`,
  `onDestroy`.
- FGS-side `captureException` on rootkey-load failure, with
  `comapeo.phase:rootkey` and `source:rootkey-store` tags. Fires before
  `sendErrorNativeFrame` so the FGS scope has the original logcat/notification
  context; the same exception is re-broadcast to Node and re-captured by the
  main-process JS adapter for the cross-process triple.

Cost: ~250 LOC native + bridge + tests. Bundle delta: sentry-android-core is
brought in transitively by `@sentry/react-native` (which is now a mandatory
peer dep), so no additional cost for consumers.

## Phase 3 — backend loader + RPC tracing

- `@sentry/node@^8`, `@sentry/core@^8`, and `import-in-the-middle` added to
  `backend/package.json`.
- `package.json`'s `files` field surfaces the built `*.map` files into the
  published npm package; consumer responsibilities for APK/IPA exclusion +
  sourcemap upload documented.
- `backend/rollup.config.ts` restructured for multi-entry output (`loader`,
  `index`, `importHook`, `lib/register`).
- New `backend/loader.mjs` parses argv, conditionally inits Sentry,
  dynamically imports `index.mjs`.
- Native side (iOS + Android) passes `loader.mjs` as the spawn target with
  `--sentry*` argv flags from `SentryConfig`.
- `handleFatal` and `onRequestHook` wired.
- Client-side `getMetadata` wired for distributed tracing; the RN-side hook
  uses `startNewTrace` to mint a fresh trace per call when no caller
  transaction exists.

Value: RPC method-level errors and durations in Sentry; backend boot failures
with proper stacktraces; baseline distributed tracing; auto-instrumentation
works because `Sentry.init()` runs before any other module loads.

Cost: ~300 LOC across loader/rollup config/native/JS; ~150–250 KB bundle
delta on every consumer **on disk** but zero runtime cost when DSN is absent.

Post-merge fixes that also landed during this phase:

- iOS forwards the `error-native` frame to Node on rootkey/watchdog failure
  (commit `6bd4852`).
- Android disables `sentry-android` auto-init at the library manifest so the
  module's `SentryFgsBridge` is the single owner of the FGS-process SDK
  lifecycle (commit `dfce999`).
- Pre-merge cleanup: drop the debug flag, sync docs, lint (commit `051912a`).

## Phase 9a — `diagnosticsEnabled` toggle + module ownership of `Sentry.init`

New `diagnosticsEnabled` pref alongside `captureApplicationData`. The module
now owns the RN-side `Sentry.init` call via `initSentry(options?)`. The host
passes allowlisted extensions (`integrations`, `beforeSend`,
`beforeBreadcrumb`, `tags`); the module reads its prefs and the
plugin-supplied `sentryConfig` and either:

- skips `Sentry.init` entirely (diagnostics off, or no DSN);
- throws if the host called `Sentry.init` themselves (clear migration error
  pointing at `initSentry`); or
- calls `Sentry.init` with locked options + the host's allowlisted extensions.

Locked options (the host's `InitSentryOptions` type does **not** include them
— TypeScript refuses them at the call site):

- `dsn`, `release`, `environment`, `sampleRate`, `enableLogs` — from the
  plugin's `sentryConfig`.
- `tracesSampleRate` — `0` when capture-application-data is off, the plugin's
  value (default `0.1`) when on. Effective gate enforced here.
- `sendDefaultPii: false` — non-overridable.

The `integrations` option is a function `(defaults) => Integration[]` so the
host can append to (not replace) our defaults. `beforeSend` and
`beforeBreadcrumb` chain: our scrubber runs first; if it drops the
event/crumb, the host's hook never sees it. (The scrubber is currently an
identity placeholder — see Phase 9b in the remaining work.)

Native gating mirrors the JS path:

- Android `ComapeoCoreService.onCreate` — reads
  `ComapeoPrefs.open(ctx).readDiagnosticsEnabled()` before
  `SentryFgsBridge.init` and before passing `sentryConfig` to `NodeJSService`.
  When off, neither runs, so the FGS bridge stays inert AND the backend
  loader receives no `--sentry*` argv.
- iOS `AppLifecycleDelegate` — same shape via
  `resolveEffectiveSentryConfig()`.

Setters that transition `true → false` call `wipeSentryOutbox(context)`
synchronously after the prefs write commits. The wipe is a filesystem
`deleteRecursively` against the documented sentry-android
(`<cacheDir>/sentry/`) / sentry-cocoa (`<NSCachesDirectory>/io.sentry/`)
cache root.

Cheap parallel fix: backend `handleFatal` now attaches `os.freemem`,
`os.totalmem`, and `fs.statfsSync` results to captured exceptions —
`@sentry/node` doesn't synthesise device context the way the RN / native
SDKs do, and this is the easiest surface to bolt those numbers onto.

## Phase 10 — offline transport via control-socket forwarding

`@sentry/node` ships an HTTP transport that drops envelopes when the network
is unreachable. The native SDKs (`sentry-android`, `sentry-cocoa`) already
run in the host process with offline-aware transports — connectivity events,
exponential backoff, `retry-after` handling, on-disk envelope cache, all
there. The Node-side transport is replaced with a forwarder that pipes
payloads to native, where they ride the existing queue.

Wire format (two `ControlFrame` variants, both Node → native):

- `{"type":"sentry-event", "payload":<event JSON>}` — single-item error-event
  envelopes. Native deserialises into a `SentryEvent` via
  `SentryEvent.Deserializer` (Android) /
  `SentryEventDecoder.decodeEvent(jsonData:)` (iOS,
  `@_spi(Private) import Sentry`) and captures via `Sentry.captureEvent` /
  `SentrySDK.capture(event:)`. Going through the capture-event path means the
  native SDK applies its scope (device, OS, app, user, native breadcrumbs) at
  capture time — so Node doesn't have to carry that context. The
  previously-shipped `sentryContext` blob in the init frame and the loader's
  `addEventProcessor` that merged it are gone.

- `{"type":"sentry-envelope", "data":<base64>}` — everything else
  (transactions, sessions, check-ins, profiles, multi-item event payloads).
  Native hands the bytes to its hybrid envelope-capture entrypoint —
  `InternalSentrySdk.captureEnvelope(bytes, false)` on Android,
  `PrivateSentrySDKOnly.envelope(with:)` + `captureEnvelope:` on iOS. Native
  scope is _not_ merged on this path — that's fine because the relevant
  transactions (RPC, boot) are opened natively and the Node-side spans
  inherit the parent's context via `continueTrace`.

The custom transport in `loader.mjs` inspects each envelope: a single-item
envelope whose only item has `type: "event"` rides the event path; anything
else falls through to the envelope path.

Buffering: two ring buffers (each 100, FIFO-evict) cover the gaps in the
boot sequence — one in `loader.mjs` for captures that happen before
`index.js` registers the sink (i.e. before the control socket binds); one in
`SimpleRpcServer` for the window between sink registration and first client
connect. The first client to connect drains both — subsequent clients (e.g.
the Android main-app `ComapeoCoreModule` connecting after the FGS) do not
get a replay, since the FGS is the only consumer of Sentry frames in
practice.

Stability note for iOS: `SentryEventDecoder` is marked `@_spi(Private)` in
sentry-cocoa — Sentry's "hybrid-SDK-only, may rename in future minors" tag.
The same selector is used internally by `SentryFileManager.readAppHangEvent`
on every cocoa release, so it's exercised continuously. The version is
pinned by `@sentry/react-native`'s podspec (`Sentry/HybridSDK '8.58.0'` for
RN 7.13.0); re-validate when bumping. Fallback if Sentry yanks the symbol:
vendor `Sources/Swift/Protocol/Codable/` (~700 LOC, self-contained) into the
iOS sources.

---

## Phase 6 — Android historical exit reasons / Phase 7a — iOS app-exit telemetry

Post-mortem visibility on OS-driven kills, per platform. Full as-built
design (tag taxonomy, level mapping, tier gating, caveats) lives in
[`sentry-integration.md` §7.5](./sentry-integration.md#75-app-exit-telemetry).

- **Android**: `ExitReasonsCollector.collectAndReport` runs on each process
  start (main process via a new `ApplicationLifecycleListener`, FGS from
  `ComapeoCoreService.onCreate`, both off the main thread), decodes
  `getHistoricalProcessExitReasons` records newer than a per-process
  high-water timestamp, and captures one event per record via
  `Sentry.captureEvent` (one shared path — pre-init the SDK no-ops in
  either process). First observation initialises the high-water mark and
  emits nothing. Wall-clock anchors (`BackgroundAnchors.kt`, same prefs
  file as the toggles) are written *after* collection so the decoder sees
  the previous session's values; the main process flips
  `backgrounded_at_wall_ms` on `ProcessLifecycleOwner` ON_STOP/ON_START.
- **iOS**: `AppExitMetricsCollector` (subscribed once from
  `AppLifecycleDelegate`, retained statically, removed best-effort in
  `applicationWillTerminate`) forwards `MXAppExitMetric` buckets through
  `SentryNativeBridge.captureMessage`, which gained an `extras` parameter.
  The decode logic (`AppExitDecoder`) is MetricKit-free and tested on
  macOS via `swift test`.
- Phase 9b.8's tier reclassification shipped as part of this work: the
  duration-derived Android fields and the iOS per-exit duplication are
  gated on `captureApplicationData`.
- Divergence from the plan: the pre-iOS-14 `appExitMetrics.supported=false`
  scope tag was dropped — the podspec floor is iOS 15.1, so the branch was
  dead code. Android keeps the equivalent `exitReasons.supported=false`
  tag (minSdk 21 < API 30).

Value: actionable visibility into the most user-impacting silent failure
class on Android (FGS killed in background, sliceable by
manufacturer/model via `oem.killer.suspected`), and the first
quantitative answer to "is iOS killing our backend in the background, and
which class of kill is it?".

Cost: ~330 LOC Kotlin + ~300 LOC tests; ~250 LOC Swift + ~180 LOC tests.
No JS/backend changes.

---

## SDK v8 + Application Metrics migration

Unlocked by `@sentry/react-native` v8 (which lock-steps sentry-android
8.43 and sentry-cocoa 9.15 — both past the Application Metrics floors).

- **Dependency bumps**: peer + dev dep `@sentry/react-native` `^7.13.0`
  → `^8.13.0` (breaking for consumers — upgrade the host app's Sentry SDK
  in the same release). `ios/ComapeoCore.podspec` moves from
  `Sentry/HybridSDK '8.58.0'` to `Sentry '9.15.0'` (cocoa 9 dropped the
  `HybridSDK` subspec; RNSentry now depends on the plain pod).
  `ios/Package.swift` pins `exact: "9.15.0"`. `android/build.gradle`
  bumps `sentry-android-core` to 8.43.0.
  `scripts/check-sentry-cocoa-pin.mjs` learned RN v8's podspec shape
  (plain `Sentry` dependency + `sentry_cocoa_version` Ruby variable).
- **cocoa 9 API drift**: one call site — `TransactionContext` grew
  nullable `sampleRate`/`sampleRand` params. The `@_spi(Private)`
  surfaces (`SentryEventDecoder`, `PrivateSentrySDKOnly`) survived the
  major unchanged.
- **Exit telemetry → metrics**: `ExitReasonsCollector` and
  `AppExitMetricsCollector` now emit one `comapeo.app.exit` count per
  kill (`Sentry.metrics().count` / `SentrySDK.metrics.count`) instead of
  events — no issue lifecycle, no regression alerts, and the iOS
  per-exit event duplication disappears (a count carries N natively).
  Event level became the `exit.severity` attribute. Both SDKs ship
  metrics enabled by default, so no init changes.
- **Tier re-split** (metrics are aggregate + low-cardinality, so they
  need fewer opt-ins): the coarse `uptime_bucket` / `bg_duration_bucket`
  / `comapeo.fgs.killed_in_background` attributes moved from usage tier
  to diagnostic; exact `alive_for_ms` / `backgrounded_for_ms` stay
  usage-tier. On iOS nothing is gated anymore.
- Plan reshaped to match: Phase 5's per-RPC spans / memory checkpoint /
  storage-size items re-tiered into Phase 11's diagnostic metrics
  inventory; Phase 11 marked unblocked.

## Summary of file changes by landed phase

### Phase 1

- `src/sentry.ts` — public sub-export. State listeners that emit a breadcrumb
  on every transition and a `captureException` on ERROR.
- `src/sentry-internal.ts` — module-private adapter holder read by Phase 3's
  RPC `onRequestHook`.
- `package.json` — `@sentry/react-native` added as a peer dependency, `exports`
  field exposing `./sentry` sub-export and `./app.plugin`.

### Phase 2a

- `app.plugin.js` (module root) — ESM Expo plugin (this package is
  `"type": "module"`). `withAndroidManifest` upserts `<meta-data>`;
  `withInfoPlist` upserts plist keys. Validates `dsn` + `environment` are
  present; throws at prebuild on misconfiguration. No-op when registered
  without a `sentry` argument.
- `android/src/main/java/com/comapeo/core/SentryConfig.kt` — typed manifest
  reader. Pure `load(metaString, defaultRelease)` overload for unit tests;
  production `loadFromManifest(context)` reads
  `PackageManager.getApplicationInfo(...).metaData`. Default release =
  `versionName + "+" + versionCode` (longVersionCode on API 28+).
- `android/src/test/java/com/comapeo/core/SentryConfigTest.kt` — JVM unit
  tests covering DSN-absent, missing-env throw, plugin-release override,
  numeric coercion, unparseable-numerics drop to null,
  captureApplicationDataDefault strict bool.
- `ios/SentryConfig.swift` — typed plist reader. Pure
  `load(from: [String: Any], defaultRelease)` for unit tests; production
  `loadFromMainBundle()` reads `Bundle.main.infoDictionary`. Accepts both
  string-coerced values (the plugin's normal output) and native plist types
  (defensive against hand-edits). Default release =
  `CFBundleShortVersionString + "+" + CFBundleVersion`.
- `ios/Tests/SentryConfigTests.swift` — XCTest cases mirroring the Kotlin
  tests.
- `ios/Package.swift` — `SentryConfig.swift` added to the SPM target's
  `sources` list so the macOS-native test suite compiles it.

### Phase 2b (Android only)

- `android/build.gradle` — `compileOnly` + `testImplementation` on
  `io.sentry:sentry-android-core:8.32.0`.
- `android/src/main/java/com/comapeo/core/SentryFgsBridge.kt` — single-file
  bridge: `SentryAndroid.init`, `addBreadcrumb`, `captureException`,
  `captureMessage`, `startBootTransaction` / `startBootSpan` / `finishSpan`.
  (The original guard/impl split was reverted.)
- `android/.../ComapeoCoreService.kt` — reads config in `onCreate`, inits the
  FGS-process Sentry hub via the bridge. FGS lifecycle breadcrumbs on
  `onCreate` / `onStartCommand` / `onDestroy`. Captures `timeout:fgsStop` on
  stop-timeout.
- `android/.../NodeJSService.kt` — opens `comapeo.boot` transaction in
  `start()`; emits state-transition breadcrumbs in `applyAndEmit`; closes
  transaction + in-flight phase spans on STARTED / ERROR; wraps
  `RootKeyStore.loadOrInitialize` in a `boot.rootkey-load` span; init-frame
  round-trip is marked by an "init frame sent" breadcrumb (paired with
  control "received: ready"); control-frame breadcrumbs on
  `started`/`ready`/`stopping`/`error`/malformed; captures `timeout:startup`
  on watchdog fire; FGS-side `captureException` on rootkey failure tagged
  `phase:rootkey`.
- `android/src/test/java/com/comapeo/core/SentryFgsBridgeTest.kt` — JVM unit
  tests pinning the no-op contract before init and the active-after-init
  contract.
- `eslint.config.js` — ignore `.claude/**/*` so leftover worktree artifacts
  don't break the lint cache.

iOS Phase 2b is deferred (likely never needed). iOS is a single-process app.
The host's `@sentry/react-native` runs `SentrySDK.start(...)` in-process and
the JS adapter feeds state transitions / errors into that hub. The
"FGS-process scope" concern that motivates the Android bridge doesn't exist
on iOS.

### Phase 3

- `backend/package.json` — `@sentry/node@^8`, `@sentry/core@^8`,
  `import-in-the-middle` dependencies.
- `backend/loader.mjs` — argv-driven `Sentry.init`, dynamic import of
  `index.mjs`.
- `backend/rollup.config.ts` — multi-entry input (`loader`, `index`,
  `importHook`, `lib/register`). `sourcemap: true` stays; no Sentry rollup
  plugin (consumer uploads).
- `package.json` (module root) — built sourcemaps (`*.map` files alongside
  the bundles in `android/src/main/assets/nodejs-project/` and
  `ios/nodejs-project/`) included in the npm package `files` field.
- `README.md` — new section documenting the consumer's responsibilities:
  APK/IPA `.map` exclusion (small gradle / Xcode snippet) and
  `sentry-cli sourcemaps upload` invocation tagged with
  `release = versionName + "+" + versionCode`.
- `backend/rollup-plugins/rollup-plugin-import-hook.mjs` — port of
  comapeo-mobile's path-rewrite plugin so
  `module.register('import-in-the-middle/hook.mjs', …)` lands on the bundled
  `./importHook.js`.
- `scripts/build-backend.ts` — passes `loader.mjs` as the spawn target
  through to native asset trees; ensures the Sentry chunk and
  `importHook`/`lib/register` files are copied alongside `index.mjs`.
- `ios/NodeJSService.swift`, `android/.../NodeJSService.kt` — `runNode` /
  `startWithArgs` call passes `loader.mjs` as the entry script (was
  `index.mjs`).
- `backend/index.js` — reads `globalThis.__comapeoSentryConfig` (set by
  loader); hooks `handleFatal` with `Sentry.captureException`; removes any
  `sentry` field handling from the `init` control-frame handler (the field
  is no longer sent — argv carries it).
- `backend/lib/comapeo-rpc.js` — accepts `sentry` option, registers
  `onRequestHook` with `op: rpc.server`.
- `src/ComapeoCoreModule.ts` — passes `getMetadata` to `createMapeoClient`
  with `op: rpc.client`; uses `startNewTrace` to mint a fresh trace per
  call when no caller transaction exists.

### Phase 9a

- `android/src/main/java/com/comapeo/core/ComapeoPrefs.kt` —
  `SharedPreferences` read/write of `diagnosticsEnabled` and
  `captureApplicationData`, plus the plugin-supplied defaults.
- `ios/ComapeoPrefs.swift` — `UserDefaults` equivalent.
- `android/.../ComapeoCoreModule.kt`, `ios/ComapeoCoreModule.swift` — Expo
  bridge `Function` entries for the four getters/setters.
- `src/sentry.ts` — `initSentry`, `getDiagnosticsEnabled`,
  `setDiagnosticsEnabled`, `getCaptureApplicationData`,
  `setCaptureApplicationData`. `initSentry` chains the host's `beforeSend`
  /`beforeBreadcrumb` after the module's (currently no-op) scrubber.
- `ios/AppLifecycleDelegate.swift` — owns the iOS-side `Sentry.init` via
  `resolveEffectiveSentryConfig()` and gates on `diagnosticsEnabled`.
- `android/.../ComapeoCoreService.kt` — reads `diagnosticsEnabled` before
  `SentryFgsBridge.init` and before passing `sentryConfig` to
  `NodeJSService`.
- `backend/index.js` — `handleFatal` attaches `os.freemem`, `os.totalmem`,
  `fs.statfsSync` as extras.

### Phase 10

- `backend/loader.mjs` — custom `transport` for `Sentry.init` that inspects
  each envelope and routes single-item error events to
  `{type:"sentry-event"}` and everything else to
  `{type:"sentry-envelope"}`; 100-frame ring buffer for the
  pre-sink-registration boot window; `SENTRY_SET_SINK_GLOBAL` global wires
  `index.js`'s broadcast in. `nativeContext` event processor +
  `__comapeoSentrySetNativeContext` global removed.
- `backend/index.js` — registers the sink against
  `controlIpcServer.broadcast`; drops `sentryContext` handling from the
  init-frame handler.
- `backend/lib/simple-rpc.js` — 100-frame ring buffer for `sentry-event` /
  `sentry-envelope` frames broadcast before any client has connected;
  drained on first client connect.
- `android/.../ControlFrame.kt`, `ios/ControlFrame.swift` — added
  `SentryEvent(payloadJson)` and `SentryEnvelope(data)` variants plus
  `sentry-event` / `sentry-envelope` parsers.
- `android/.../NodeJSService.kt` — dispatches both variants in
  `handleControlMessage` to `SentryFgsBridge.captureEventJson` /
  `captureEnvelopeBase64`; `sendInitFrame` drops the `sentryContext` field.
- `android/.../ComapeoCoreModule.kt` — both variants as no-op branches (FGS
  owns capture; main-app ignores).
- `android/.../SentryFgsBridge.kt` — `captureEventJson` via
  `SentryEvent.Deserializer` + `Sentry.captureEvent`; `captureEnvelopeBase64`
  via `InternalSentrySdk.captureEnvelope(bytes, false)`.
- `android/.../SentryNativeContext.kt` — deleted.
- `ios/NodeJSService.swift` — dispatches both variants; `sendInitFrame` drops
  the `sentryContext` field.
- `ios/SentryNativeBridge.swift` — `@_spi(Private) import Sentry`;
  `captureEventJson` via `SentryEventDecoder.decodeEvent(jsonData:)` +
  `SentrySDK.capture(event:)`; `captureEnvelopeBase64` via
  `PrivateSentrySDKOnly.envelope(with:)` + `captureEnvelope:`.
- `ios/SentryNativeContext.swift` — deleted; entry removed from
  `Package.swift`.
- `ios/AppLifecycleDelegate.swift` — doc comment trimmed.
- `android/.../ControlFrameTest.kt`, `ios/Tests/ControlFrameTests.swift` —
  4 new cases each covering the two variants + missing-field-malformed
  paths.

### Phase 6 / Phase 7a

- `android/src/main/java/com/comapeo/core/ExitReasonsCollector.kt` — new;
  filter/decode pipeline (`ExitRecord` → `ExitReasonEvent`), high-water
  bookkeeping, `collectAndReport` production entry point with capture via
  `Sentry.captureEvent`.
- `android/src/main/java/com/comapeo/core/ExitReasonTags.kt` — new; decode
  tables for `REASON_*` / `IMPORTANCE_*` ints, level mapping,
  `exit.intentional` and `oem.killer.suspected` predicates.
- `android/src/main/java/com/comapeo/core/BackgroundAnchors.kt` — new;
  lambda-injected prefs wrapper for the per-process wall-clock anchors and
  high-water keys.
- `android/src/main/java/com/comapeo/core/ComapeoCoreApplicationLifecycleListener.kt`
  — new; main-process collection + anchor stamping +
  `ProcessLifecycleOwner` backgrounded-at observer.
- `android/.../ComapeoCorePackage.kt` — registers the application lifecycle
  listener.
- `android/.../ComapeoCoreService.kt` — FGS-side collection + anchor stamp
  on `serviceScope` after `SentryFgsBridge.init`.
- `android/.../SentryTags.kt` — `exit.*`, `oem.killer.suspected`,
  bucket-tag, and `comapeo.exit` category constants.
- `android/src/test/.../ExitReasonsCollectorTest.kt`,
  `ExitReasonTagsTest.kt` — 25 JVM tests (high-water behaviour, tag/level
  mapping, tier gating, bucket boundary cases, decode-table coverage).
- `ios/AppExitMetricsCollector.swift` — new; pure `AppExitDecoder` +
  `MXMetricManagerSubscriber` adapter (`#if canImport(MetricKit) && os(iOS)`).
- `ios/AppLifecycleDelegate.swift` — subscribe in
  `didFinishLaunchingWithOptions` (diagnostics-gated), unsubscribe in
  `applicationWillTerminate`.
- `ios/SentryNativeBridge.swift` — `captureMessage` gains `extras`.
- `ios/SentryTags.swift` — `exit.*` / `window_id` tag and `comapeo.exit`
  category constants.
- `ios/Package.swift` — `AppExitMetricsCollector.swift` added to sources.
- `ios/Tests/AppExitMetricsCollectorTests.swift` — 11 decoder tests
  (duplication semantics, tier gating, level/cause-class mapping, unknown
  buckets, window-id stability).

## Phase 11 — toggle rework, metrics layer, PII scrubbers

Landed the three-toggle model (§11.1), the always-on metrics layer
(§11.2/§11.3), and the symmetric PII scrubbers (§9b.1/§9b.5).

Toggle rework (#75):
- Renamed `captureApplicationData` → `applicationUsageData` across the JS
  API, native bridge methods, the on-device stored key, the Expo plugin
  field, and the Node CLI flags. Deprecated aliases (`getCaptureApplicationData`
  / `setCaptureApplicationData`, native `setCaptureApplicationData`, the
  `--captureApplicationData` argv flag, and the plugin field) forward to
  the new names for one minor release. A one-shot stored-key migration runs
  on first `ComapeoPrefs.open` on both platforms.
- New `debug` toggle: `get/setDebugEnabled` (JS), `setDebugEnabled` (native),
  `sentry.debug` + `sentry.debugEnabledAtMs` prefs slots, `--debug` argv,
  `debugDefault` plugin field. Auto-off (§11.5; shipped as 72h, up from the
  planned 24h) implemented in the `readDebugEnabled` reader on both
  platforms; re-enable refreshes the window.
- Device classification (§11.2.b): new `DeviceTags.{kt,swift}` bucket the
  device low/mid/high by RAM + cores and compute `<platform>.<major>`.
  Plumbed to RN via the `sentryConfig.deviceTags` constant and to Node via
  `--deviceClass` / `--osMajor` / `--platformTag`.
- `tracesSampleRate` now derives from `debug` (1.0 while on, else the
  plugin-configured rate, 0 when unset), not from the usage toggle.

Metrics layer (#76):
- New `backend/lib/metrics.js` + `src/sentry-metrics.ts`: wrappers around
  `Sentry.metrics.*` that inject `platform` on every metric, attach
  `device_class` / `os_major` only on the `.by_device` mirrors, no-op when
  Sentry is off, and run a `before_metric_send` forbidden-tag filter.
- RPC hooks split on both sides: always record the metric; only create a
  Sentry span when `debug` is on, recording the metric while the span is
  active so it links to the trace.
- Backend `consoleIntegration` moved behind `debug`. 60s memory /
  event-loop sampler, boot-phase durations, state transitions, and a
  bucketed storage-size counter wired in `index.js` / `withSpan`.

PII scrubbers (#77):
- Shared regex list (rootKey markers, 22-char base64, lat/lng markers) in
  `src/sentry-scrub.ts` (RN) and the hand-mirrored `backend/before-send.js`
  (Node). RN wires the real scrubber as `beforeSend` ahead of the host's
  chain and a host-only URL `beforeBreadcrumb`; Node registers the same
  scrub as an `addEventProcessor`. Walks message, exception text, extra,
  contexts, breadcrumb message + data, and span description + data; HTTP
  breadcrumb URLs reduce to host-only.

Tests: `backend/lib/metrics.test.mjs`, `backend/lib/before-send.test.mjs`,
extended `backend/lib/sentry.test.mjs` (debug on/off branching) and
`src/__tests__/sentry.test.js` (scrubber + traces gating); native
migration / debug-auto-off / device-boundary tests in
`ComapeoPrefs{Test,Tests}` and new `DeviceTags{Test,Tests}` on both
platforms (run on CI emulator/Xcode).
