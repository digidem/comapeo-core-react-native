# Testing & CI architecture

How this repo is tested, how the GitHub Actions workflows fit together, and the
cross-cutting models (the merge queue, required checks, the secrets/trust
boundary, and the cost controls on the slow device-test suites) that make the
set of workflows hang together.

This is the maintainer-facing **why**. For the contributor **how-to** — local
commands, the PR/commit conventions, the release flow — see
[`CONTRIBUTING.md`](../CONTRIBUTING.md). For the code architecture (process
model, IPC, lifecycle) see [`ARCHITECTURE.md`](./ARCHITECTURE.md).

---

## 1. TL;DR

- Tests run in **seven layers**, cheapest first: JS lint/unit → Swift-package →
  JVM unit → Android instrumented (emulator) → iOS integration (simulator) → iOS
  device build → full **BrowserStack** e2e on real devices.
  ([§2](#2-the-test-layers))
- The native/integration layers run inside the **integration app**
  (`apps/integration`); the device e2e runs a separate **e2e app** (`apps/e2e`).
  Two different apps with two different test mechanisms —
  ([§2.1](#21-the-two-test-apps)).
- Each layer maps to a job in one of the **test workflows** (`lint.yml`,
  `android-tests.yml`, `ios-tests.yml`, `e2e-*.yml`). The e2e jobs are factored
  into a reusable workflow shared by two callers. ([§3](#3-the-workflows))
- Merges go through a **required merge queue**. Required checks are evaluated on
  the `merge_group` commit, which is why every test workflow also triggers on
  `merge_group`. ([§4](#4-the-merge-queue-and-required-checks))
- The expensive BrowserStack e2e is collapsed behind a single **`e2e / Gate`**
  required check and **runs in the merge queue, not on every PR** — a plain PR
  defers to the queue; a maintainer opts a PR in with the **`run-e2e`** label or
  a manual dispatch. ([§5](#5-when-the-expensive-e2e-runs))
- Secrets are withheld from Dependabot/fork PRs. They build without secrets and
  run the device suite only after a maintainer reviews the diff and adds
  **`safe-to-test`**, which routes through an isolated `pull_request_target`
  workflow. The reusable workflow keeps untrusted code execution and the secrets
  in separate jobs. ([§6](#6-secrets-and-the-trust-boundary))

---

## 2. The test layers

The in-app behaviour is exercised at increasing cost and fidelity. The cheap
layers catch most regressions in seconds; the expensive ones catch the
integration and real-device failures the cheap ones can't see.

| # | Layer | Framework / command | Device? | Runner | App | Required check |
|---|---|---|---|---|---|---|
| 1 | JS lint + unit | `expo-module lint`, `expo-module test` | no | ubuntu | — | `Lint & Unit Tests` |
| 2 | Swift package | `cd ios && swift test` (`ComapeoCore-Package`) | no | macOS | — | `Swift Package Tests (macOS)` |
| 3 | JVM unit | Gradle `:comapeo-core-react-native:testDebugUnitTest` | no | ubuntu | example | `JVM Unit Tests` |
| 4 | Android instrumented | Gradle `connectedDebugAndroidTest` (AndroidJUnit4 + UiAutomator) | emulator | ubuntu + KVM | example | `Instrumented Tests (30)` |
| 5 | iOS integration | `xcodebuild test` | simulator | macOS | example | `Integration Tests (Example App)` |
| 6 | iOS device build | `xcodebuild build` for `generic/platform=iOS` | no (build only) | macOS | example | `iOS Device Build (xcframework codesign verification)` |
| 7 | End-to-end | Maestro flow on BrowserStack real devices | real devices | ubuntu + BrowserStack | e2e | `e2e / Gate` |

What each layer is actually for:

- **Layer 1 — JS lint + unit.** The fast gate. ESLint plus the TypeScript unit
  tests under `src/__tests__/` (the RN-facing adapter). Seconds, no native
  toolchain.
- **Layer 2 — Swift package.** Builds only the platform-portable Swift sources
  (`NodeJSIPC`, `NodeJSService`, `Log`) and exercises framing / IPC / service
  lifecycle / `waitForFile` against Unix sockets via Darwin APIs — no simulator
  needed, so it's fast-feedback for the iOS native layer. Tests live in
  `ios/Tests/` (the `ComapeoCore-Package` test target). See
  [`ARCHITECTURE.md`](./ARCHITECTURE.md) §3.
- **Layer 3 — JVM unit.** Pure-JVM Android tests (message-framing protocol
  encode/decode) with no emulator.
- **Layer 4 — Android instrumented.** Boots an emulator and runs the real
  `:ComapeoCore` foreground service: IPC connect/send/receive, process
  isolation, the shutdown/recovery path, socket-file lifecycle. This is where
  the Android process model ([`ARCHITECTURE.md`](./ARCHITECTURE.md) §2.2) is
  actually verified.
- **Layer 5 — iOS integration.** Runs the integration app's XCTest targets on a
  simulator (`CoreManagerSmokeTest`, `ServiceLifecycleTest`, `RootKeyStoreTests`,
  `ComapeoCoreModuleTests`, …): the embedded `MapeoManager` instantiates and the
  service lifecycle works end-to-end in the single-process iOS model.
- **Layer 6 — iOS device build.** Tests that the app **builds for a physical
  device** — something no other layer checks. iOS native addons ship as
  xcframeworks that Xcode links per-architecture and embeds (with `@rpath` install
  names — see [`BUILD.md`](./BUILD.md) for how they're built and packaged); a
  device build links the app against each framework's **device** (arm64)
  slice and runs the embed step. The simulator integration tests (layer 5) only
  ever load the *simulator* slice, so a broken device slice — a missing arch, a
  wrong install name, a structure Xcode rejects — passes them unnoticed. This job
  catches it with `xcodebuild build` against a generic iOS device (build only — CI
  has no real iOS hardware, and signing is disabled, so it checks the link + embed
  rather than real signatures). **Android needs no equivalent because the failure
  mode doesn't exist there:** Android addons are plain `.so` files packaged into
  the APK and resolved by `dlopen` at runtime — no per-library signing, no
  build-time link/embed step — so anything wrong with the device ABIs can only
  surface at runtime, which the layer-7 device run covers.
- **Layer 7 — End-to-end.** The full stack on real devices, driven by Maestro
  through BrowserStack. This layer **includes its own build steps**: `build-android`
  (`gradlew assembleRelease`) and `build-ios` (`xcodebuild archive`) build the
  `apps/e2e` release APK and device `.ipa` — including the Android `arm64` /
  `armeabi-v7a` build that nothing else produces (the instrumented tests build
  x86_64 only) — before uploading them and running the suite.
  [§3.1](#31-the-e2e-jobs) lists the jobs; [§7](#7-the-browserstack-e2e-end-to-end)
  covers the device run.

### 2.1 The two test apps

Layers 3–7 run against an Expo app, but **not the same one** — and the two apps
test in fundamentally different ways. This is the distinction to keep straight:

| | `apps/integration` | `apps/e2e` |
|---|---|---|
| Package / bundle id | `core-react-native-integration` / `com.comapeo.core.integration` | `core-react-native-e2e` / `com.comapeo.core.e2e` |
| What the tests *are* | **Native test targets** — Swift `XCTest` + Kotlin `androidTest`/JVM, compiled into the app | An **in-app JS test suite** (`src/tests/*.ts`) run by `TestRunner.tsx` |
| Who runs them | The platform test runners: `xcodebuild test`, Gradle `connectedDebugAndroidTest` | The app runs them itself on launch/tap; **Maestro** (on BrowserStack) drives the UI and reads the verdict |
| What they verify | The native module, RN bridge, and service lifecycle at the platform layer | The full RN → native → Node stack doing real `@comapeo/core` work (project CRUD, the map server, basic lifecycle) |
| Layers | 3, 4, 5, 6 | 7 |
| CI | `android-tests.yml`, `ios-tests.yml` | `e2e-*.yml` |

So **`apps/integration`** is where compiled native tests live: the iOS XCTest
targets are injected into the prebuilt app by an app-only config plugin
(`apps/integration/plugins/with-ios-tests/`), and the Android instrumented/JVM
tests build and run through `apps/integration/android`'s Gradle. It doubles as a
runnable dev app (`expo run:*`, `expo start --dev-client`).

**`apps/e2e`** is a thin harness: its `TestRunner.tsx` runs the suites under
`apps/e2e/src/tests/` (`basic`, `project-crud`, `map-server`) in-process against
the real backend and surfaces the result through testIDs (`all-tests-done`,
`all-tests-passed`). The Maestro flow ([§7](#7-the-browserstack-e2e-end-to-end))
just taps **Run tests** and asserts on those testIDs — all the real assertions
run inside the app.

Test sources by layer:

| Layer | Location |
|---|---|
| JS unit (1) | `src/__tests__/` |
| Swift package (2) | `ios/Tests/` (`ComapeoCore-Package` test target) |
| JVM unit / Android instrumented (3–4) | module's `android/src/test/` + `android/src/androidTest/`, plus the integration-app suites injected from `apps/integration/tests/android/` |
| iOS integration (5) | `apps/integration/tests/ios/` (re-injected into the prebuilt integration app by `with-ios-tests`) |
| e2e (7) | `apps/e2e/src/tests/` (the in-app suite) + `maestro/e2e.yaml` (the driving flow) |

> `apps/integration` and `apps/e2e`'s `ios/`/`android/` trees are gitignored and
> regenerated by `expo prebuild`; the test files under `apps/integration/tests/` are
> the source of truth and get re-injected on prebuild.

---

## 3. The workflows

| Workflow | Triggers | Jobs → check contexts | Purpose |
|---|---|---|---|
| [`lint.yml`](../.github/workflows/lint.yml) | `pull_request`, `merge_group` | `Lint & Unit Tests` | Layer 1 |
| [`android-tests.yml`](../.github/workflows/android-tests.yml) | `pull_request`, `merge_group`, `workflow_dispatch` | `JVM Unit Tests` (always), `Instrumented Tests (30)` (gated) | Layers 3–4 |
| [`ios-tests.yml`](../.github/workflows/ios-tests.yml) | `pull_request`, `merge_group`, `workflow_dispatch` | `Swift Package Tests (macOS)` (always), `Integration Tests (Example App)` + `iOS Device Build (…)` (gated) | Layers 2, 5–6 |
| [`detect-heavy-ci.yml`](../.github/workflows/detect-heavy-ci.yml) | `workflow_call` | (classifier — no check) | Shared run/skip decision for the heavy native suites; called by the two above |
| [`e2e-tests.yml`](../.github/workflows/e2e-tests.yml) | `merge_group`, `workflow_dispatch`, `pull_request` (internal) | one `e2e` job → calls `e2e-reusable.yml` | Layer 7, internal/trusted path |
| [`e2e-trusted.yml`](../.github/workflows/e2e-trusted.yml) | `pull_request_target: [labeled, synchronize]` | `e2e` → `e2e-reusable.yml`, plus `remove-label` + `reset-on-push` (label hygiene) | Layer 7, Dependabot/fork path |
| [`e2e-reusable.yml`](../.github/workflows/e2e-reusable.yml) | `workflow_call` | the e2e jobs ([§3.1](#31-the-e2e-jobs)) | Shared body for the two callers above |
| [`pr-title.yml`](../.github/workflows/pr-title.yml) | `pull_request_target` | `Lint conventional title`, `Apply changelog label` | Conventional-Commits title lint + changelog label |
| [`release.yml`](../.github/workflows/release.yml) | `workflow_dispatch`, `pull_request: [closed]` | `release` | Two-phase npm release (see CONTRIBUTING.md) |

Plus [`dependabot.yml`](../.github/dependabot.yml) (config, not a workflow):
opens dependency PRs with a 3-day cooldown.

Three things to notice:

1. **Every test workflow also triggers on `merge_group`.** That's not redundant
   — it's required, see [§4](#4-the-merge-queue-and-required-checks).
2. **The e2e jobs live in `e2e-reusable.yml`, called from two places.**
   `e2e-tests.yml` handles internal-branch PRs and the merge queue (secrets
   available); `e2e-trusted.yml` handles Dependabot/fork PRs behind the
   `safe-to-test` label ([§6](#6-secrets-and-the-trust-boundary)). Factoring them
   out means the path/label gating and the gate job are defined once and both
   callers honour them.
3. **The heavy jobs run conditionally; the fast ones always run.** `android-tests`
   and `ios-tests` call `detect-heavy-ci.yml` from a `changes` job and gate their
   slow suites (`Instrumented Tests (30)`, `Integration Tests (Example App)`,
   `iOS Device Build`) on its `run` output — the same merge-queue / `run-e2e` /
   docs-skip logic the e2e suite uses ([§5](#5-when-the-expensive-e2e-runs)). The
   fast suites (`JVM Unit Tests`, `Swift Package Tests`, `Lint & Unit Tests`) run
   on every PR.

### 3.1 The e2e jobs

Both callers invoke `e2e-reusable.yml` from a job named `e2e`, so its jobs
surface as nested check contexts `e2e / <job name>`. The jobs (in dependency
order):

| Job (`name`) | Holds secrets? | Runs PR code? | What it does |
|---|---|---|---|
| `changes` (Detect relevant changes) | no | no (lists filenames via API) | Decides `run_e2e` ([§5](#5-when-the-expensive-e2e-runs)) |
| `build-android` (Build (Android)) | **no** | **yes** | Builds the `apps/e2e` APK |
| `build-ios` (Build (iOS)) | **no** | **yes** | Builds the `apps/e2e` IPA |
| `upload-android` (Upload Android app) | **yes** | no | Uploads the APK to BrowserStack |
| `upload-ios` (Upload iOS app) | **yes** | no | Uploads the IPA to BrowserStack |
| `upload-test-suite` (Upload test suite) | **yes** | no | Zips + uploads `maestro/e2e.yaml` |
| `test-android` (Run tests (Android)) | **yes** | no (action from base ref) | Triggers + polls the Android device run |
| `test-ios` (Run tests (iOS)) | **yes** | no (action from base ref) | Triggers + polls the iOS device run |
| `gate` (Gate) | no | no | The single required check — always reports ([§4.2](#42-skipping-a-required-check-without-leaving-it-pending)) |

The "holds secrets / runs PR code" split is the trust boundary —
[§6.2](#62-the-reusable-workflow-keeps-code-and-secrets-apart) explains why the
build jobs (which run untrusted code) and the upload/test jobs (which hold the
BrowserStack secrets) are never the same job.

---

## 4. The merge queue and required checks

Merges into `main` go through a **required GitHub merge queue** (configured in
the branch ruleset). When a PR is marked *Merge when ready*, GitHub builds a
temporary `merge_group` commit (this PR on top of `main` + anything ahead of it
in the queue) and evaluates the required status checks **against that commit**,
not against the PR head. The queue is what lets several PRs land without each one
re-running CI every time another merges.

Two consequences shape every workflow here:

### 4.1 Workflows must trigger on `merge_group`

A required check is only satisfied for a merge group if a workflow actually runs
on the `merge_group` event and reports that context. That's why `lint.yml`,
`android-tests.yml`, `ios-tests.yml`, and `e2e-tests.yml` all list
`merge_group:` in their triggers. Drop it from any of them and that workflow's
required checks would never report on the queue → the queue stalls.

### 4.2 Skipping a required check without leaving it "pending"

**A required check that never reports blocks the PR** — it stays "pending"
forever. So the obvious way to skip expensive work — a `paths:`/`paths-ignore:`
filter on the workflow trigger — backfires: a path-skipped workflow never runs,
its required check never reports, and the PR can never merge.

The fix used for the e2e suite (issue
[#139](https://github.com/digidem/comapeo-core-react-native/issues/139), PR
[#142](https://github.com/digidem/comapeo-core-react-native/pull/142)) is a
single **gate job** that *always reports*:

- A `changes` job decides whether the expensive jobs should run
  ([§5](#5-when-the-expensive-e2e-runs)).
- The build/upload/test jobs are gated on that decision and skip when it's
  false.
- A final **`gate` job** (`needs:` every e2e job, `if: always()`) passes when the
  suite was legitimately skipped **or** every job succeeded, and **fails closed**
  on any failure/cancellation or a path-detection error.

Because the gate reports on **both** `pull_request` and `merge_group`, a skipped
e2e suite still produces a green `e2e / Gate` — the PR stays mergeable instead of
stuck pending. This also collapses what used to be five nested required checks
(`e2e / Build (Android)`, `e2e / Build (iOS)`, `e2e / Run tests (Android)`,
`e2e / Run tests (iOS)`, `e2e / Upload test suite`) into one.

> **Why not a job-level skip on the required check itself?** GitHub treats a
> *skipped* required check as *passing*. So skipping the gate would let a PR
> merge without the suite ever running. The gate is therefore never skipped — it
> runs and explicitly decides pass/fail. The trust path relies on the same
> distinction ([§6](#6-secrets-and-the-trust-boundary)): for an untrusted PR the
> gate is *absent*, not *skipped*, so the PR stays blocked until a maintainer
> approves it.

> **The heavy native suites take the simpler route.** `Instrumented Tests (30)`,
> `Integration Tests (Example App)`, and `iOS Device Build` are gated by a
> `needs`/`if` on the `detect-heavy-ci` result and simply **skip** when gated out
> — relying on *skipped = passing*. That's safe here precisely because they hold
> no secrets and have no trust boundary to protect (unlike e2e), so there's no
> "untrusted PR must stay blocked" requirement forcing an always-reporting gate.
> Only e2e needs the gate-job pattern.

---

## 5. When the expensive e2e runs

BrowserStack isn't billed per device-minute — the constraint is the account's
**parallel-session limit**, so running the suite on every PR push would contend
for those slots. It's also slow in CI terms, but the *device* run is the cheap
part (~2 min per platform): the app builds dominate (~8–9 min each for
`build-android` / `build-ios`). The `changes` job in `e2e-reusable.yml` (an
`actions/github-script` step — read-only file listing, no checkout, so it's safe
even on the `pull_request_target` path) decides `run_e2e` per event:

| Trigger | Runs the e2e device jobs? |
|---|---|
| `merge_group` | **Yes**, unless the merge group is docs/config-only |
| `workflow_dispatch` | **Yes** — explicit manual request |
| `pull_request` (internal) | **No** by default; **Yes** if the PR carries the **`run-e2e`** label |
| `pull_request_target` (Dependabot/fork) | **Yes** once `safe-to-test` is added, unless docs/config-only |

The design intent:

- **The merge queue is the gate.** The authoritative e2e run is on the
  `merge_group` commit — the actual thing about to land. A plain PR defers to the
  queue and gets a cheap green gate in the meantime, so we don't spend the build
  time and a parallel slot on every push.
- **Devs opt in for early feedback.** Touched device-facing code and want to see
  e2e before queueing? Add the **`run-e2e`** label (or trigger a manual
  dispatch). It runs on the PR and again in the queue.
- **Docs/config changes always skip.** A change touching only `*.md`, `docs/**`,
  `LICENSE`, editor dotfiles, or other `.github/**` config skips the device jobs
  on every event — the gate still passes. A change to the **e2e machinery
  itself** (`.github/workflows/e2e-*.yml`,
  `.github/actions/run-browserstack-maestro/**`) counts as code so it's
  self-tested. When the classifier is unsure (empty/failed file lookup) it runs
  e2e — a wasted run is cheaper than a missed regression.

The trade-off: an e2e regression on a plain PR surfaces at **queue time** (a
failing `e2e / Gate` ejects the PR from the queue) rather than on the PR itself.
The `run-e2e` label is the escape hatch.

The **same gating applies to the heavy native suites**: `Instrumented Tests (30)`,
`Integration Tests (Example App)`, and `iOS Device Build` are gated on
`detect-heavy-ci.yml`'s `run` output (merge queue / `run-e2e` / docs-skip) and
skip as *passing* when gated out
([§4.2](#42-skipping-a-required-check-without-leaving-it-pending)). Only the
**fast** suites stay always-on for every PR — `JVM Unit Tests`, `Swift Package
Tests`, and `Lint & Unit Tests` — so most regressions still surface pre-queue
without a label.

### Labels

| Label | Meaning | Who/what consumes it |
|---|---|---|
| `run-e2e` | Run the heavy suites (e2e **and** the slow native suites) on a PR; otherwise they run only in the merge queue | `e2e-reusable.yml` + `detect-heavy-ci.yml` |
| `safe-to-test` | Maintainer reviewed an untrusted (Dependabot/fork) diff — OK to build it with secrets | `e2e-trusted.yml` ([§6](#6-secrets-and-the-trust-boundary)) |

---

## 6. Secrets and the trust boundary

The BrowserStack e2e needs credentials. GitHub withholds secrets from workflows
triggered by Dependabot and fork PRs, so an untrusted dependency or contributor
can't exfiltrate them. That splits the e2e into two paths that are logical
complements — exactly one runs for any given PR:

- **Internal branches** (same-repo, non-draft, non-Dependabot) → `e2e-tests.yml`
  on `pull_request`/`merge_group`. Secrets are available.
- **Dependabot / forks** → `e2e-trusted.yml` on `pull_request_target`, gated on
  the **`safe-to-test`** label. `pull_request_target` runs in the **base** repo's
  context (secrets available) but checks out the **base** workflow definitions,
  so a PR can't rewrite what runs. Two helper jobs keep the approval honest:
  `remove-label` strips `safe-to-test` after each run, and `reset-on-push` strips
  it on every new commit (`synchronize`) — so an approval can never outlive the
  exact diff it covered. Maintainers review the diff — including the Socket.dev
  supply-chain report — before adding it.

The `if:` trust gate in `e2e-tests.yml` and the untrusted gate in
`e2e-trusted.yml` must stay logical complements; keep them in sync or e2e runs
twice (or not at all) for some PR class.

### 6.1 Why an untrusted PR is *blocked*, not *passed*

For an untrusted PR the trust `if:` gates out `e2e-tests.yml`'s `e2e` job, so the
reusable workflow never runs and `e2e / Gate` is **absent** — not *skipped*.
That's the crucial distinction: a skipped required check counts as *passing*
([§4.2](#42-skipping-a-required-check-without-leaving-it-pending)) — which would
let untrusted code merge unreviewed — whereas an *absent* one leaves the PR
unmergeable until `safe-to-test` triggers `e2e-trusted.yml` and the gate reports.

### 6.2 The reusable workflow keeps code and secrets apart

Within `e2e-reusable.yml` the jobs ([§3.1](#31-the-e2e-jobs)) are split so
untrusted code execution and the secrets never share a runner:

- **Build jobs** check out the PR head and execute untrusted code (npm install,
  Gradle, `expo prebuild`, `xcodebuild`) but hold **no secrets**. They emit the
  built `.apk`/`.ipa` as an artifact.
- **Upload jobs** hold the BrowserStack secrets but only download the artifact
  blob and `curl` it up — they never check out or run PR code.
- **Test jobs** check out the `run-browserstack-maestro` composite action from
  the **base** ref (no PR ref), so the action that receives the secrets is never
  the PR's version.

`cache_key_prefix` namespaces the build cache for untrusted PRs so a labelled PR
can't poison the shared cache. The `changes` path-detection job only lists
filenames via the API (no checkout), so it's safe on the trusted path too.

---

## 7. The BrowserStack e2e, end to end

The device run is orchestrated by `e2e-reusable.yml` ([§3.1](#31-the-e2e-jobs))
plus the
[`run-browserstack-maestro`](../.github/actions/run-browserstack-maestro) action:

1. **Build** the e2e Expo app (`apps/e2e`) per platform → `.apk` / `.ipa`
   artifact (`build-android` / `build-ios`).
2. **Upload** the app binary to BrowserStack (`upload-android` / `upload-ios`)
   and the Maestro flow (`maestro/e2e.yaml`, zipped) to the BrowserStack Maestro
   v2 test-suite endpoint (`upload-test-suite`); capture the returned `bs://…`
   URLs.
3. **Run** via the composite action (`test-android` / `test-ios`): trigger a
   Maestro build against a small device matrix, poll every 30 s until a terminal
   status, and on cancellation stop the BrowserStack build.

The app harness and flow are deliberately thin. `apps/e2e` is an Expo app whose
UI exposes a **Run tests** button and result testIDs; the actual assertions run
*in-app* (`apps/e2e/src/tests/`, against the embedded backend — see
[§2.1](#21-the-two-test-apps)). `maestro/e2e.yaml` just drives the UI and reads
the verdict:

```yaml
- launchApp: { clearState: true }
- tapOn: "Run tests"
- extendedWaitUntil: { visible: { id: "all-tests-done" }, timeout: ${TIMEOUT} }
- takeScreenshot: results
- assertVisible: { id: "all-tests-passed" }
```

### 7.1 Infra-flake retries

Real-device farms are flaky in ways that aren't the code's fault — the XCUITest
driver connection resetting during `launchApp`'s implicit permission grant,
app-install failures, WebDriverAgent hiccups. The action distinguishes these from
real assertion failures: a failed build is **only** retried (up to
`max_attempts`, default 3) when **every** failed session's Maestro log matches an
infra signature. Any failed session without an infra signature — or whose log
can't be fetched — is treated as a real failure and never retried away. On every
failure it dumps the per-session report and the tail of each Maestro log so the
actual cause is visible in the CI log.

### 7.2 Running the e2e suite locally

The same `apps/e2e` suite runs on a local emulator/simulator — **including iOS**
— driving a **Release** build with the exact `maestro/e2e.yaml` flow CI runs on
BrowserStack. (The "iOS only works on BrowserStack" idea was a misread: the device
binary CI uploads is unsigned and can't run on a simulator, but a local
`expo run:ios` Release build signs with your Apple dev team, so the embedded
backend's keychain access works.)

```bash
npm run e2e:ios          # or: npm run e2e:android — Release build + install onto a sim/emulator
npm run e2e:test         # drive it with Maestro (maestro/e2e.yaml)
```

A Release build disables the dev menu / LogBox overlays and loads its embedded JS
bundle (no Metro), so the local run is a faithful copy of the CI run and needs no
dev-build workarounds — hence a single flow, [`e2e.yaml`](../maestro/e2e.yaml),
shared by both. There's deliberately no dev-client e2e variant: a dev build's
only edge is fast JS reload, and nearly all of this module is native +
nodejs-mobile code that needs a full rebuild on change anyway.
[`CONTRIBUTING.md`](../CONTRIBUTING.md) §"End-to-end locally" has the same how-to.

---

## 8. Local development

The exact, always-current invocations live in the workflow files; the common
ones are in [`CONTRIBUTING.md`](../CONTRIBUTING.md). Quick reference:

```bash
npm run lint      # layer 1 — ESLint
npm run test      # layer 1 — JS unit tests
cd ios && swift test   # layer 2 — Swift package tests (macOS, no simulator)
./scripts/run-instrumented-tests.sh --unit-only   # layer 3 — JVM unit (no device)
./scripts/run-instrumented-tests.sh               # layers 3–4 — instrumented (emulator)
```

The full e2e suite runs locally too — see [§7.2](#72-running-the-e2e-suite-locally).

`npm run open:ios` / `npm run open:android` open the integration app in
Xcode / Android Studio.

Run at least `npm run lint` and `npm run test` before opening a PR. The native
and device layers run in CI; reproduce them locally only when iterating on
platform-specific code.

---

## 9. References

- Workflows: [`lint.yml`](../.github/workflows/lint.yml),
  [`android-tests.yml`](../.github/workflows/android-tests.yml),
  [`ios-tests.yml`](../.github/workflows/ios-tests.yml),
  [`detect-heavy-ci.yml`](../.github/workflows/detect-heavy-ci.yml),
  [`e2e-tests.yml`](../.github/workflows/e2e-tests.yml),
  [`e2e-trusted.yml`](../.github/workflows/e2e-trusted.yml),
  [`e2e-reusable.yml`](../.github/workflows/e2e-reusable.yml),
  [`pr-title.yml`](../.github/workflows/pr-title.yml),
  [`release.yml`](../.github/workflows/release.yml).
- Composite action:
  [`run-browserstack-maestro`](../.github/actions/run-browserstack-maestro).
- Maestro flows: [`maestro/e2e.yaml`](../maestro/e2e.yaml) (the e2e suite, run on
  BrowserStack in CI and against a local Release build),
  [`maestro/fgs-restart.yaml`](../maestro/fgs-restart.yaml) (Android FGS recovery).
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — local setup, commands, commit/PR/
  release conventions.
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — process model, IPC, lifecycle (what
  the native/e2e suites verify).
- [`BUILD.md`](./BUILD.md) — how the native addons are built, packaged, and
  loaded (what the build-and-link layers 6–7 exercise).
- e2e gating design:
  [#139](https://github.com/digidem/comapeo-core-react-native/issues/139),
  [#142](https://github.com/digidem/comapeo-core-react-native/pull/142). Merge
  queue support: PR #136.
