# UDS / RPC Bridge Benchmark Suite

> **Note (2026-05-05):** this document captures the original v1
> implementation plan, in which the bench bundle and rollup config
> lived inside the production module behind a `comapeoBench=true`
> Gradle toggle / `ENV['COMAPEO_BENCH']` Podfile mutation. The
> benchmark has since been refactored: the bench backend, rollup
> config, and Expo config plugin moved to `apps/benchmark/`, and the
> module exposes a generic `comapeoBackendDir` override (Gradle
> property → `BuildConfig.COMAPEO_BACKEND_DIR` on Android,
> `ComapeoBackendDir` Info.plist key on iOS) that the bench app's
> plugin sets. Goals (boot phases, RPC sweeps, sinks, Maestro flows)
> are unchanged; only the build wiring differs. For current behavior
> see `apps/benchmark/backend/`, `apps/benchmark/plugins/with-comapeo-bench/`,
> and the `comapeoBackendDir` blocks in `android/build.gradle` and
> `ios/AppLifecycleDelegate.swift`.

## Context

`@comapeo/core-react-native` connects React Native to a `nodejs-mobile`
runtime over a pair of UNIX-domain sockets (control + comapeo) with a
length-prefixed JSON RPC framing. We want to measure two things on real
devices via **BrowserStack App Automate**:

1. **UDS connection initialisation** — the boot phases already named in
   `backend/index.js` and modelled by the Sentry plan: `listen-control`,
   `ipc-connect (control)`, `rootkey-load`, `init`, `construct`,
   `ipc-connect (comapeo)`.
2. **RPC bridge performance** — round-trip latency for small messages and
   throughput at varying payload sizes (e.g. 64B / 1KB / 64KB / 1MB), both
   cold and steady-state.

This is **phase 1**. Real `@comapeo/core` API benchmarks (project ops, sync,
sqlite) come later; here we want to isolate the parts of the bridge that
*we* own so device-specific regressions in framing / IPC / RPC plumbing
surface without `@comapeo/core` noise. The repo currently has **zero**
benchmark or timing instrumentation; the Sentry plan
(`docs/sentry-integration-plan.md`) is detailed but unimplemented.

## Approaches considered

- **Sentry-based (rejected as transport):** the Sentry plan defines exactly
  the spans we want (`comapeo.boot` with phase children, `op:"rpc"` named by
  `request.method`). But Sentry is sample-based, has per-span overhead, ships
  via HTTPS to a remote service, and Phases 1–3 of the plan are unimplemented
  prerequisites. Wrong transport for tight-loop microbenchmarks. **Reuse the
  taxonomy, not the implementation.**
- **Native test runner only (rejected as primary):** `androidx.benchmark` /
  XCTest `measure` blocks would run on BrowserStack natively and dump
  reports without custom transport — but they don't exercise the
  RN→native→Node JS path, only the native↔Node leg. Insufficient for RPC
  round-trip timing as users feel it.
- **Standalone benchmark app + custom JS bundle (chosen):** isolates the
  bits we own from `@comapeo/core` init noise; lets us drive the bridge
  through the real RN→native→Node path; matches the existing aspirational
  `e2e/.maestro/ipc-roundtrip.yaml` (which already references `send-button` /
  `benchmark-result` IDs that `App.tsx` doesn't yet have).

## Recommended design

### Single benchmark app + stripped backend, with shared Sentry-shaped instrumentation

- A new `apps/benchmark/` is a slim copy of `apps/example/`. UI exposes
  payload-size selectors, a Send button (`testID="send-button"`), and a result
  panel (`testID="benchmark-result"`).
- A new `backend/index.bench.js` is the bench-only nodejs-mobile entry. It
  reuses the same `pre-listening` → `started` → `ready` state machine as
  `backend/index.js` so the native module is unchanged, but **does not import
  `@comapeo/core`** and registers only `echo` and `payload(sizeBytes)` RPC
  methods.
- `scripts/build-backend.ts` learns a `--bench` mode that emits the bench
  bundle into bench-only sibling paths (see "Consumer isolation" below) so it
  cannot leak into a regular consumer app.
- A pluggable telemetry sink emits the Sentry plan's exact span shape
  (`comapeo.boot` transaction with `boot.listen-control`,
  `boot.ipc-connect (control)`, `boot.rootkey-load`, `boot.init`,
  `boot.construct`, `boot.ipc-connect (comapeo)`, plus `op:"rpc"` spans named
  `request.method.join(".")`). When Sentry plan Phase 3 lands, a single
  `SentryAdapterSink` (~30 LOC) implementing the same `recordSpan` interface
  drops in without changing call sites.
- Production `backend/index.js` is **not modified** in this phase. The shared
  helpers live in `backend/lib/` and are consumed by `index.bench.js` only;
  the Sentry plan can adopt them later.
- Maestro flows drive runs on BrowserStack App Automate.
- Results escape via **HTTP POST through the BrowserStack Local tunnel** to a
  small Node receiver (`scripts/lib/bench-receiver.ts`) running on the
  BrowserStack runner.

## Consumer isolation (bench bundle ships only to the bench app)

Hard requirement: a regular consumer (the example app, third-party apps
installing `@comapeo/core-react-native` from npm) MUST NOT receive any bench
artefacts in their APK or IPA. Three independent guards enforce this:

1. **Path isolation in the working tree.** Production assets land at
   `android/src/main/assets/nodejs-project/` and `ios/nodejs-project/` —
   exactly the locations the AAR `sourceSets.main.assets` and the
   podspec's `s.resources = ['nodejs-project']` already pick up
   (`android/build.gradle:93-104`, `ios/ComapeoCore.podspec:48`). Bench
   assets land at sibling paths the production module's gradle/podspec
   does **not** reference by default:
   - `android/src/bench/assets/nodejs-project/` *(new build variant
     sourceSet, off by default)*
   - `ios/nodejs-project-bench/` *(included only when the consumer's
     Podfile sets `ENV['COMAPEO_BENCH'] = '1'` before pod install)*
2. **Default-off opt-in at consumer build time, driven by an Expo config
   plugin (no checked-in `android/`/`ios/` folders).**
   - The bench app declares its native wiring entirely in `app.json` /
     `app.config.js` via a single config plugin
     `./plugins/with-comapeo-bench`. `expo prebuild` regenerates the
     `android/` and `ios/` directories on demand; nothing under those
     paths is checked into git for `apps/benchmark/`.
   - Android: the plugin uses `withGradleProperties` to write
     `comapeoBench=true` into the consuming app's
     `android/gradle.properties`. The module's own `android/build.gradle`
     reads `rootProject.findProperty('comapeoBench')` and, when set,
     replaces `assets.srcDirs` with `src/bench/assets/` (and zeroes out
     `src/debug/assets/` so the production debug overlay doesn't shadow
     the bench bundle in debug builds). Consumers that don't set the
     property (`apps/example/`, third-party apps) keep the default
     `src/main/assets/` and never see `src/bench/`. The earlier design
     used a `bench` productFlavor + `missingDimensionStrategy`, but that
     hit AGP / Gradle 9 strict variant resolution ambiguity for Expo
     apps that don't declare matching flavors of their own (expo/expo
     #18315 et al.); a project property dodges the variant-attribute
     graph entirely.
   - iOS: the plugin uses `withPodfile` (the canonical
     `@expo/config-plugins` mod for Podfile string edits) to prepend
     `ENV['COMAPEO_BENCH'] = '1'` to the regenerated `ios/Podfile`
     above the autolinking block, so the env var is set before pod
     install reads `ComapeoCore.podspec`. The module's
     `ComapeoCore.podspec` reads that env var at `pod install` time
     and, when set, stages a copy of `nodejs-project-bench/` to
     `.bench-staging/nodejs-project/` and adds it to `s.resources`
     **alongside** the production `nodejs-project/`. CocoaPods'
     `[CP] Copy Pods Resources` rsyncs both into the app bundle in
     declaration order, with the same destination basename
     (`<App>.app/nodejs-project/`); the bench overlay's `index.mjs`
     replaces production's at the same path. If the bench bundle is
     missing (forgot to run `--bench`), staging is skipped and only
     the production bundle ships — the bench app boots production
     instead of crashing on a missing resource. With no env var, the
     podspec ships exactly today's `nodejs-project/`, byte-identical.
     An earlier iteration tried to do the rename via an Xcode Run
     Script build phase (added by the plugin via `withXcodeProject`)
     but CocoaPods 1.x doesn't reliably position user script phases
     after `[CP] Copy Pods Resources`, so the rename ran before the
     bench files were on disk and silently no-op'd; the staging
     approach sidesteps the ordering problem entirely. The Podfile
     mutation guards with an `includes(sentinel)` check so re-runs of
     `expo prebuild` are idempotent. Note:
     `expo-build-properties.ios.extraPods` cannot express a subspec
     opt-in (no `:subspecs` field) and only appends — it cannot
     override the autolinked `pod 'ComapeoCore'` entry — which is why
     the env-var-driven podspec is the right shape.
3. **Publish-time exclusion.** `package.json`'s `files` array does not
   list `android/src/bench/` or `ios/nodejs-project-bench/`, so even if a
   developer accidentally runs `--bench` before publishing, those paths
   are physically excluded from the npm tarball. The bench app consumes
   the working tree via Expo autolinking from `../..`, not from the
   published package, so it still works locally.

Net effect: a consumer running `npm install @comapeo/core-react-native`
followed by `expo prebuild` gets exactly today's APK/IPA. A consumer
that has the working tree locally but doesn't apply the
`with-comapeo-bench` plugin also gets exactly today's APK/IPA. Only the
bench app, whose `app.json` lists the plugin, links the bench bundle.

### Native loader behaviour under the bench variant

`nodejs-mobile` boots from a fixed `nodejs-project/` path inside the app
sandbox. To avoid changing the native loader, the bench variant
substitutes the bundle in place:

- Android: when `comapeoBench=true`, the module's `android/build.gradle`
  reassigns `sourceSets.main.assets.srcDirs` to `['src/bench/assets']`
  (and empties `sourceSets.debug.assets.srcDirs` so the production
  debug overlay doesn't shadow it). The bench bundle's relative path
  inside its sourceSet is `nodejs-project/`, the same as production,
  so the AAR ships exactly one `nodejs-project/` — bench's. Default
  consumer (no property) keeps the production `src/main/assets`.
- iOS: the podspec stages `nodejs-project-bench/` to
  `.bench-staging/nodejs-project/` at pod install time when
  `ENV['COMAPEO_BENCH']` is set, and lists both `nodejs-project` and
  `.bench-staging/nodejs-project` in `s.resources`. CocoaPods rsyncs
  them in declaration order to `<App>.app/nodejs-project/`; the bench
  overlay's `index.mjs` replaces production's. The default build
  (no env var) ships only the production `nodejs-project/`.

Both variants leave the existing `NodeJSService.swift` and Android Node
launcher unchanged.

## Standalone operation

The bench app must be useful without any host-side infrastructure: a
developer should be able to `expo prebuild`, install the APK/IPA on any
device, tap Send, and read results on screen. Concretely:

- The default sink is `JsonFileSink` writing to the app's Documents
  directory (`<sandbox>/Documents/comapeo-bench/<runId>.ndjson`) plus an
  on-screen render in the `benchmark-result` panel: per-phase boot
  durations, per-payload-size RPC p50/p95/p99 over a fixed iteration
  count.
- The `HttpSink` is **opt-in**, controlled by a UI toggle and an
  optional URL field defaulting to `http://localhost:<port>`. It posts
  in addition to (not instead of) the on-device render, and any
  network failure is logged and ignored — the on-device experience is
  unchanged.
- An "Export results" button on the result panel reveals the file path
  and (on iOS) opens the system share sheet so a user can pull NDJSON
  off the device without `adb pull` / Xcode access. Useful for ad-hoc
  device testing.
- A timestamped run id is shown on screen so screenshots from manual
  runs can be cross-referenced if needed.

## Release-variant correctness

Real-app perf-feel is debug-misleading (interpreter JS, no R8/ProGuard,
unminified RN bundle). Both build types must work end-to-end:

- Android: the `comapeoBench=true` Gradle property is orthogonal to
  `debug` / `release` build types — it just selects which `assets`
  srcDirs the AAR ships. R8 / ProGuard don't touch assets, so a
  `release` build of the bench app bundles the same bench
  `nodejs-project/` as `debug`. Verification:
  `expo run:android --variant release` (or `./gradlew :app:assembleRelease`
  in the prebuild output) and unzip-grep the APK.
- iOS: the podspec's `ENV['COMAPEO_BENCH']` check + staging copy run at
  `pod install` time, before any per-configuration build, so Release
  and Debug configurations both embed the bench bundle identically.
  Verification: archive the bench app with the Release configuration
  and inspect `<App>.app/nodejs-project/`.

## Critical files

**Shared instrumentation (used now by `index.bench.js`, reused by Sentry Phase 3 later):**
- `backend/lib/telemetry-sink.js` *(new)* — `recordSpan({op, name, startNs, endNs, attrs})` interface plus `JsonFileSink` / `HttpSink` / `NoopSink` implementations.
- `backend/lib/boot-spans.js` *(new)* — helpers that wrap the four phase blocks (`listen-control`, `init`, `construct`, `ipc-connect (comapeo)`) plus `ipc-connect (control)` and `rootkey-load` with `recordSpan({ op:"boot", name:"boot.<phase>" })`. Phase names mirror the existing `Object.assign(e, { phase })` tags in `backend/index.js` and the Sentry plan §7.4.2.

**Bench backend entry:**
- `backend/index.bench.js` *(new)* — listens on the same control + comapeo socket paths, runs the same state machine, but skips `createComapeo` and registers `echo` / `payload(sizeBytes)`. Wires the boot-span helpers and exposes per-RPC timing via `comapeo-rpc`-equivalent server.
- `backend/lib/bench-rpc.js` *(new)* — minimal RPC server that accepts the bench methods and emits `op:"rpc"` spans on each request via the shared sink.
- `scripts/build-backend.ts` — add `--bench` mode. In bench mode rollup is invoked with `INPUT=index.bench.js` and `OUTPUT_DIR_*` pointing at `android/src/bench/assets/nodejs-project/` and `ios/nodejs-project-bench/` (NOT the production `src/main/` and `ios/nodejs-project/` paths). Default mode is unchanged.
- `backend/rollup.config.ts` — accept the entry override; exclude `@comapeo/core` and its drizzle migrations from the bench bundle.

**Module-side wiring for the bench variant:**
- `android/build.gradle` — read `rootProject.findProperty('comapeoBench')`. When set, reassign `sourceSets.main.assets.srcDirs = ['src/bench/assets']` (replacing — not appending — the production `src/main/assets`) and zero out `sourceSets.debug.assets.srcDirs` so the debug overlay can't shadow bench in debug builds. Default consumer (`apps/example/`, third parties) leaves the property unset and keeps the production `src/main/assets`. The earlier `productFlavors` design hit AGP variant-attribute ambiguity for Expo apps without matching flavors of their own.
- `ios/ComapeoCore.podspec` — read `ENV['COMAPEO_BENCH']` at evaluation time. When set, stage `ios/nodejs-project-bench/` to `ios/.bench-staging/nodejs-project/` and add it to `s.resources` alongside the production `nodejs-project/`. CocoaPods' `[CP] Copy Pods Resources` rsyncs both into `<App>.app/nodejs-project/` in declaration order, with the bench `index.mjs` overlaying. Default consumers leave the env var unset and ship the existing single `nodejs-project` resource, byte-identical.
- `package.json` — `files` array stays as-is; `android/src/bench/`, `ios/nodejs-project-bench/`, and `ios/.bench-staging/` are deliberately omitted (and explicitly negated via `!`-patterns) so they cannot leak via `npm publish`.

**Bench app (no checked-in `android/`/`ios/`):**
- `apps/benchmark/` *(new)* — slim sibling of `apps/example/`, but only owns: `App.tsx`, `app.json`, `babel.config.js`, `metro.config.js`, `index.ts`, `package.json`, `tsconfig.json`, and `plugins/`. Native dirs are not checked in; `expo prebuild` generates them on demand using the config plugin below. Uses Expo autolinking back to `../..`, same pattern as `apps/example`.
- `apps/benchmark/app.json` *(new)* — declares the bench plugin **only**: `"plugins": ["./plugins/with-comapeo-bench"]`. Does **not** include `with-android-tests` or `with-ios-tests` from `apps/example/plugins/`.
- `apps/benchmark/App.tsx` *(new)* — UI with `testID="send-button"`, `testID="benchmark-result"`, payload-size selector, warmup/steady-state toggle, on-screen p50/p95/p99 render, "Export results" button, and an opt-in "POST to receiver" toggle + URL field (default `http://localhost:<port>`, off by default).
- `apps/benchmark/plugins/with-comapeo-bench/` *(new)* — single config plugin. Uses canonical `@expo/config-plugins` mods only:
  - `withGradleProperties` — writes `comapeoBench=true` into `android/gradle.properties`. Idempotent (lookup-then-update). The module's `android/build.gradle` reads this and swaps in the bench asset srcDirs.
  - `withPodfile` — prepends `ENV['COMAPEO_BENCH'] = '1'` to `ios/Podfile` above the autolinking block, guarded by an `includes(sentinel)` check for idempotency. The podspec reads the env var at pod install time and stages the bench bundle.
  - No `withXcodeProject` — an earlier iteration tried to add an Xcode Run Script build phase to rename `nodejs-project-bench/` → `nodejs-project/` in the app bundle, but CocoaPods 1.x doesn't reliably position user script phases after `[CP] Copy Pods Resources`, so the rename ran before the bench files were on disk and silently no-op'd. The pod-install-time staging in the podspec sidesteps the ordering problem entirely.

**RN-side timing hook:**
- `src/ComapeoCoreModule.ts` (`CoreMessagePort`) — accept an optional JS-side `recordSpan` so RN-thread timestamps round-trip with each RPC. Same structural shape Sentry plan §6.2 will need later.

**Maestro flows:**
- `e2e/.maestro/bench-rpc.yaml` *(new)* and per-payload-size flows (`bench-payload-64B.yaml`, `bench-payload-1KB.yaml`, `bench-payload-64KB.yaml`, `bench-payload-1MB.yaml`).

**Receiver:**
- `scripts/lib/bench-receiver.ts` *(new)* — small Node HTTP receiver bound to localhost; collates incoming spans into per-device NDJSON and a CSV summary keyed by BrowserStack session id / device tag.

## Results pipeline

Two transports, ranked by who's running the bench:

- **Default (always works, including offline):** `JsonFileSink` writes
  NDJSON to the app's Documents directory and the app renders summary
  stats on screen. An "Export results" button reveals the path /
  triggers the share sheet on iOS. This is the only required transport
  for a developer running the bench app standalone on any device.
- **Optional (orchestrated BrowserStack runs):** `HttpSink` POSTs every
  span to a user-supplied URL (default `http://localhost:<port>` reached
  via BrowserStack Local tunnel). Toggle defaults to off. Connection
  failures are silently logged so the on-device experience never
  regresses when no receiver is listening. `bench-receiver.ts` writes
  per-device NDJSON + CSV when in use.
- **No reliance on Sentry HTTPS upload.**

## Phasing

1. **Phase 1 (1–2 days):** shared sink (`telemetry-sink.js`, `boot-spans.js`) +
   `backend/index.bench.js` skeleton with boot-phase spans wired. Verify
   locally with `JsonFileSink` against a dev build.
2. **Phase 2 (2–3 days):** dual-bundle build wiring + consumer isolation
   (`scripts/build-backend.ts --bench`, rollup config, `comapeoBench`
   Gradle property toggle in the module's `android/build.gradle`,
   env-var-driven resource staging in the module's
   `ios/ComapeoCore.podspec`). Confirm production `nodejs-project/` is
   byte-identical to before; bench bundle lands in
   `android/src/bench/...` / `ios/nodejs-project-bench/` and is absent
   from a default `apps/example/` build (release variant too).
3. **Phase 3 (3–5 days):** `apps/benchmark/` skeleton (no checked-in
   `android/`/`ios/`) with `App.tsx` UI, RPC bridge wiring, per-payload-size
   handlers, warmup/steady-state logic, on-screen p50/p95/p99 render,
   "Export results" button, and the `with-comapeo-bench` config plugin.
   Verify with `expo prebuild` followed by both **debug and release**
   builds on Android and iOS that the bench bundle is embedded and the
   app produces results standalone (with the HTTP toggle off).
4. **Phase 4 (2 days):** Maestro flows (`bench-rpc.yaml` + per-payload-size);
   BrowserStack Local tunnel verified with at least three real devices (one
   low-end Android, one mid-range Android, one iOS); per-device CSV produced.
5. **Phase 5 (later, when Sentry plan reaches Phase 3):** add
   `SentryAdapterSink` implementing the same `recordSpan` interface; the
   Sentry plan adopts `boot-spans.js` for the production `backend/index.js`.
   No call-site changes here.

## Out of scope (deferred)

- `@comapeo/core` API benchmarks (`project.observation.create`, sync, sqlite).
  The whole point of the stripped `index.bench.js` is to **avoid** measuring
  these.
- Modifications to production `backend/index.js`. Stays untouched until the
  Sentry plan adopts the shared helpers.
- Boot timing of the **real** backend including `@comapeo/core` init. We're
  measuring the parts we own; full-stack production-feel boot timing is a
  separate question (revisit after Sentry plan Phase 3 lands and gives us
  that signal automatically).
- Memory benchmarks, sync session throughput, real Sentry transport.

## Verification

- **Phase 1:** run the bench backend locally with
  `--telemetry=file:/tmp/boot.ndjson`; inspect six `boot.*` spans with sane
  durations; confirm `--telemetry=noop` produces no behavioural diff.
- **Phase 2:** run `npm run backend:build` and `npm run backend:build -- --bench`;
  confirm `android/src/main/assets/nodejs-project/` and `ios/nodejs-project/`
  are unchanged (diff vs main) and that the bench bundle lands at
  `android/src/bench/assets/nodejs-project/` + `ios/nodejs-project-bench/`
  without `@comapeo/core` artefacts. **Consumer-isolation check:** build
  `apps/example/` for Android (both debug and release) and iOS (both
  configurations), then unzip the resulting APK / IPA and grep for
  `index.bench` and `nodejs-project-bench` — all must be absent. Then run
  `expo prebuild` in `apps/benchmark/` and build it for the same four
  configurations; confirm the bench bundle IS present in its APK / IPA in
  both debug and release. Finally run `npm pack` and inspect the
  tarball: no `android/src/bench/` and no `ios/nodejs-project-bench/`
  entries.
- **Phase 3 standalone check:** with the device offline (or with the
  HTTP toggle off), launch the bench app, run a full sweep, hit
  "Export results", and confirm the NDJSON file exists at the displayed
  path and the on-screen p50/p95/p99 numbers are populated. Repeat with
  a release build to confirm release-mode timings are produced.
- **Phase 3:** run `apps/benchmark` locally on an Android emulator + iOS
  simulator with `bench-receiver.ts` listening on `127.0.0.1:<port>`; tap Send
  through each payload-size selector; confirm spans arrive (one `op:"boot"`
  transaction at launch, `op:"rpc"` spans per Send, with `attrs.bytes`
  matching the selected size).
- **Phase 4:** submit to BrowserStack App Automate with three devices; confirm
  per-device NDJSON arrives in the receiver and that distinct device tags
  appear; eyeball the CSV summary for plausible per-device latency
  differences.
- **Phase 5 (when Sentry lands):** flip the sink at one call site and confirm
  Sentry dashboards show the same `boot.*` and `op:"rpc"` spans without code
  changes elsewhere.
