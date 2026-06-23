# Testing & CI architecture

How this repo is tested, how the GitHub Actions workflows fit together, and the
cross-cutting models (the merge queue, required checks, the secrets/trust
boundary, and the cost controls on the paid device suite) that make the set of
workflows hang together.

This is the maintainer-facing **why**. For the contributor **how-to** — local
commands, the PR/commit conventions, the release flow — see
[`CONTRIBUTING.md`](../CONTRIBUTING.md). For the code architecture (process
model, IPC, lifecycle) see [`ARCHITECTURE.md`](./ARCHITECTURE.md).

---

## 1. TL;DR

- Tests run in **seven layers**, cheapest first: JS lint/unit → Swift-package →
  JVM unit → Android instrumented (emulator) → iOS integration (simulator) → iOS
  device build → full **BrowserStack** e2e on real devices. §2.
- Each layer maps to a job in one of the **test workflows** (`lint.yml`,
  `android-tests.yml`, `ios-tests.yml`, `e2e-*.yml`). The e2e jobs are factored
  into a reusable workflow shared by two callers. §3.
- Merges go through a **required merge queue**. Required checks are evaluated on
  the `merge_group` commit, which is why every test workflow also triggers on
  `merge_group`. §4.
- The expensive BrowserStack e2e is collapsed behind a single **`e2e / Gate`**
  required check and **runs in the merge queue, not on every PR** — a plain PR
  defers to the queue; a maintainer opts a PR in with the **`run-e2e`** label or
  a manual dispatch. §5.
- Secrets are withheld from Dependabot/fork PRs. They build without secrets and
  run the device suite only after a maintainer reviews the diff and adds
  **`safe-to-test`**, which routes through an isolated `pull_request_target`
  workflow. The reusable workflow keeps untrusted code execution and the secrets
  in separate jobs. §6.

---

## 2. The test layers

The in-app behaviour is exercised at increasing cost and fidelity. The cheap
layers catch most regressions in seconds; the expensive ones catch the
integration and real-device failures the cheap ones can't see.

| # | Layer | Framework / command | Device? | Runner | Required check |
|---|---|---|---|---|---|
| 1 | JS lint + unit | `expo-module lint`, `expo-module test` | no | ubuntu | `Lint & Unit Tests` |
| 2 | Swift package | `cd ios && swift test` (`ComapeoCore-Package`) | no | macOS | `Swift Package Tests (macOS)` |
| 3 | JVM unit | Gradle `:comapeo-core-react-native:testDebugUnitTest` | no | ubuntu | `JVM Unit Tests` |
| 4 | Android instrumented | Gradle `connectedDebugAndroidTest` (AndroidJUnit4 + UiAutomator) | emulator | ubuntu + KVM | `Instrumented Tests (30)` |
| 5 | iOS integration | `xcodebuild test` (example app) | simulator | macOS | `Integration Tests (Example App)` |
| 6 | iOS device build | `xcodebuild build` for `generic/platform=iOS` | no (build only) | macOS | `iOS Device Build (xcframework codesign verification)` |
| 7 | End-to-end | Maestro flow on BrowserStack real devices | real devices | ubuntu + BrowserStack | `e2e / Gate` |

What each layer is actually for:

- **Layer 1 — JS lint + unit.** The fast gate. ESLint plus the TypeScript unit
  tests over `src/` (the RN-facing adapter). Seconds, no native toolchain.
- **Layer 2 — Swift package.** Builds only the platform-portable Swift sources
  (`NodeJSIPC`, `NodeJSService`, `Log`) and exercises framing / IPC / service
  lifecycle / `waitForFile` against Unix sockets via Darwin APIs — no simulator
  needed, so it's fast-feedback for the iOS native layer. See
  [ARCHITECTURE.md §3](./ARCHITECTURE.md).
- **Layer 3 — JVM unit.** Pure-JVM Android tests (message-framing protocol
  encode/decode) with no emulator.
- **Layer 4 — Android instrumented.** Boots an emulator and runs the real
  `:ComapeoCore` foreground service: IPC connect/send/receive, process
  isolation, the shutdown/recovery path, socket-file lifecycle. This is where
  the Android process model (ARCHITECTURE.md §2.2) is actually verified.
- **Layer 5 — iOS integration.** Builds the example app and runs its XCTest
  targets on a simulator (`CoreManagerSmokeTest`, `ServiceLifecycleTest`,
  `RootKeyStoreTests`, `ComapeoCoreModuleTests`, …): the embedded
  `MapeoManager` instantiates and the service lifecycle works end-to-end in the
  single-process iOS model.
- **Layer 6 — iOS device build.** Phase 2 ships device + simulator slices in one
  xcframework per native addon (see
  [build-architecture-plan.md](./build-architecture-plan.md)). The simulator
  integration tests exercise the runtime; this job `xcodebuild build`s against a
  generic iOS device to prove the **device** slice links and codesigns (CI can't
  run on real iOS hardware, so it builds but doesn't test).
- **Layer 7 — End-to-end.** The full stack on real devices, driven by Maestro
  through BrowserStack. §7 covers the mechanics.

The test source lives next to what it tests:

| Layer | Location |
|---|---|
| JS unit | `src/__tests__/` |
| Swift package | `ios/Tests/` (the `ComapeoCore-Package` test target) |
| JVM unit / Android instrumented | `android/src/test/`, `android/src/androidTest/`, plus the example-app injected suites under `apps/example/tests/android/` |
| iOS integration | `apps/example/tests/ios/` (re-injected into the prebuilt example app by an example-only config plugin) |
| e2e | `apps/e2e/` (the Expo harness app) + `maestro/e2e.yaml` (the flow) |

> `apps/example/`'s `ios/` and `android/` trees are gitignored and regenerated
> by `expo prebuild`; the test files under `apps/example/tests/` are the source
> of truth and get re-injected on prebuild.

---

## 3. The workflows

| Workflow | Triggers | Jobs → check contexts | Purpose |
|---|---|---|---|
| [`lint.yml`](../.github/workflows/lint.yml) | `pull_request`, `merge_group` | `Lint & Unit Tests` | Layer 1 |
| [`android-tests.yml`](../.github/workflows/android-tests.yml) | `pull_request`, `merge_group`, `workflow_dispatch` | `JVM Unit Tests`, `Instrumented Tests (30)` | Layers 3–4 |
| [`ios-tests.yml`](../.github/workflows/ios-tests.yml) | `pull_request`, `merge_group`, `workflow_dispatch` | `Swift Package Tests (macOS)`, `Integration Tests (Example App)`, `iOS Device Build (…)` | Layers 2, 5–6 |
| [`e2e-tests.yml`](../.github/workflows/e2e-tests.yml) | `merge_group`, `workflow_dispatch`, `pull_request` (internal) | `e2e / Gate` (+ nested build/run jobs) | Layer 7, internal/trusted path |
| [`e2e-trusted.yml`](../.github/workflows/e2e-trusted.yml) | `pull_request_target: [labeled, synchronize]` | `e2e / Gate` (+ nested) | Layer 7, Dependabot/fork path |
| [`e2e-reusable.yml`](../.github/workflows/e2e-reusable.yml) | `workflow_call` | (defines the e2e jobs) | Shared body for the two callers above |
| [`pr-title.yml`](../.github/workflows/pr-title.yml) | `pull_request_target` | `Lint conventional title`, `Apply changelog label` | Conventional-Commits title lint + changelog label |
| [`release.yml`](../.github/workflows/release.yml) | `workflow_dispatch`, `pull_request: [closed]` | `release` | Two-phase npm release (see CONTRIBUTING.md) |

Plus [`dependabot.yml`](../.github/dependabot.yml) (config, not a workflow):
opens dependency PRs with a 3-day cooldown.

Two things to notice in that table:

1. **Every test workflow also triggers on `merge_group`.** That's not redundant
   — it's required, see §4.
2. **The e2e jobs live in `e2e-reusable.yml`, called from two places.**
   `e2e-tests.yml` handles internal-branch PRs and the merge queue (secrets
   available); `e2e-trusted.yml` handles Dependabot/fork PRs behind the
   `safe-to-test` label (§6). Factoring them out means the path/label gating and
   the gate job are defined once and both callers honour them.

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

GitHub has a sharp edge: **a required check that never reports blocks the PR**
(it sits "pending" / "expected" forever). This rules out the naive way to skip
expensive work — adding `paths:`/`paths-ignore:` to a workflow trigger. A
path-skipped workflow doesn't run, so its required check never reports, so the
PR can't merge.

The fix used for the e2e suite (issue
[#139](https://github.com/digidem/comapeo-core-react-native/issues/139), PR
[#142](https://github.com/digidem/comapeo-core-react-native/pull/142)) is a
single **gate job** that *always reports*:

- A `changes` job decides whether the expensive jobs should run (§5).
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
> distinction (§6): for an untrusted PR the gate is *absent*, not *skipped*, so
> the PR stays blocked until a maintainer approves it.

> **Ruleset change required for the gate.** Switching the required check from the
> five nested contexts to `e2e / Gate` is an admin-only edit to the branch
> ruleset (the GitHub CLI can't PATCH rulesets). It lands with
> [#142](https://github.com/digidem/comapeo-core-react-native/pull/142).

---

## 5. When the expensive e2e runs

BrowserStack device time is paid and slow (~15–25 min per run). The `changes`
job in `e2e-reusable.yml` (an `actions/github-script` step — read-only file
listing, no checkout, so it's safe even on the `pull_request_target` path)
decides `run_e2e` per event:

| Trigger | Runs the e2e device jobs? |
|---|---|
| `merge_group` | **Yes**, unless the merge group is docs/config-only |
| `workflow_dispatch` | **Yes** — explicit manual request |
| `pull_request` (internal) | **No** by default; **Yes** if the PR carries the **`run-e2e`** label |
| `pull_request_target` (Dependabot/fork) | **Yes** once `safe-to-test` is added, unless docs/config-only |

The design intent:

- **The merge queue is the gate.** The authoritative e2e run is on the
  `merge_group` commit — the actual thing about to land. A plain PR defers to the
  queue and gets a cheap green gate in the meantime, so we don't pay for a device
  run on every push.
- **Devs opt in for early feedback.** Touched device-facing code and want to see
  e2e before queueing? Add the **`run-e2e`** label (or trigger a manual
  dispatch). It runs on the PR and again in the queue.
- **Docs/config changes never pay.** A change touching only `*.md`, `docs/**`,
  `LICENSE`, editor dotfiles, or other `.github/**` config skips the device jobs
  on every event — the gate still passes. A change to the **e2e machinery
  itself** (`.github/workflows/e2e-*.yml`,
  `.github/actions/run-browserstack-maestro/**`) counts as code so it's
  self-tested. When the classifier is unsure (empty/failed file lookup) it runs
  e2e — a wasted run is cheaper than a missed regression.

The trade-off: an e2e regression on a plain PR surfaces at **queue time** (a
failing `e2e / Gate` ejects the PR from the queue) rather than on the PR itself.
The `run-e2e` label is the escape hatch.

The cheaper native suites (Android, iOS — layers 2–6) are free GitHub-hosted
runs and stay **always-on** for every PR, so most regressions still surface
pre-queue without a label.

### Labels

| Label | Meaning | Who/what consumes it |
|---|---|---|
| `run-e2e` | Run the full e2e on this internal PR (otherwise it runs only in the queue) | `e2e-tests.yml` via the `changes` job |
| `safe-to-test` | Maintainer reviewed an untrusted (Dependabot/fork) diff — OK to build it with secrets | `e2e-trusted.yml` (§6) |

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
  so a PR can't rewrite what runs. The label is removed after each run and on
  every new push (`synchronize`), so an approval can never outlive the exact diff
  it covered. Maintainers review the diff — including the Socket.dev
  supply-chain report — before adding it.

The `if:` trust gate in `e2e-tests.yml` and the untrusted gate in
`e2e-trusted.yml` must stay logical complements; keep them in sync or e2e runs
twice (or not at all) for some PR class.

### 6.1 Why an untrusted PR is *blocked*, not *passed*

For an untrusted PR, `e2e-tests.yml`'s `e2e` job is gated out by the trust `if:`,
so the reusable workflow is never instantiated and `e2e / Gate` is **absent** on
the PR head — the required check has nothing to satisfy it, so the PR is blocked
until a maintainer adds `safe-to-test` and `e2e-trusted.yml` produces the gate.
This depends on the absent-vs-skipped distinction from §4.2: a job-level skip
would report *skipped* = *passing* and let untrusted code merge unreviewed.

### 6.2 The reusable workflow keeps code and secrets apart

Within `e2e-reusable.yml` the jobs are split so untrusted code execution and the
secrets never share a runner:

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

The device run is orchestrated by `e2e-reusable.yml` plus the
[`run-browserstack-maestro`](../.github/actions/run-browserstack-maestro) action:

1. **Build** the e2e Expo app (`apps/e2e`) per platform → `.apk` / `.ipa`
   artifact (the build jobs, §6.2).
2. **Upload** the app binary to BrowserStack and the Maestro flow
   (`maestro/e2e.yaml`, zipped) to the BrowserStack Maestro v2 test-suite
   endpoint; capture the returned `bs://…` URLs.
3. **Run** via the composite action: trigger a Maestro build against a small
   device matrix, poll every 30 s until a terminal status, and on cancellation
   stop the BrowserStack build.

The app harness and flow are deliberately thin. `apps/e2e` is an Expo app whose
UI exposes a **Run tests** button and result testIDs; the actual assertions run
*in-app* (against the embedded backend). `maestro/e2e.yaml` just drives the UI
and reads the verdict:

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

### 7.2 Local iteration

- **Android**: run Maestro locally against an emulator. The
  [`e2e/`](../e2e/) helper scripts (`run-e2e.sh`, `run-instrumented-tests.sh`)
  build and drive a local run.
- **iOS**: the e2e **cannot** run on a local simulator — the backend needs a
  keychain entitlement the simulator can't grant, and the process crashes on
  launch. iOS e2e iteration goes through BrowserStack (trigger via the API,
  inspect Maestro screenshots / device logs).

> The older [`e2e/README.md`](../e2e/README.md) predates the current layout
> (it references `example/` rather than `apps/example/`, Maestro Cloud rather
> than BrowserStack, and an older socket name). Treat this document and the
> workflow files as the source of truth until that README is refreshed.

---

## 8. Local development

The exact, always-current invocations live in the workflow files; the common
ones are in [`CONTRIBUTING.md`](../CONTRIBUTING.md). Quick reference:

```bash
npm run lint      # layer 1 — ESLint
npm run test      # layer 1 — JS unit tests
cd ios && swift test   # layer 2 — Swift package tests (macOS, no simulator)
./e2e/run-instrumented-tests.sh --unit-only   # layer 3 — JVM unit (no device)
./e2e/run-instrumented-tests.sh               # layers 3–4 — instrumented (emulator)
```

Run at least `npm run lint` and `npm run test` before opening a PR. The native
and device layers run in CI; reproduce them locally only when iterating on
platform-specific code.

---

## 9. References

- Workflows: [`lint.yml`](../.github/workflows/lint.yml),
  [`android-tests.yml`](../.github/workflows/android-tests.yml),
  [`ios-tests.yml`](../.github/workflows/ios-tests.yml),
  [`e2e-tests.yml`](../.github/workflows/e2e-tests.yml),
  [`e2e-trusted.yml`](../.github/workflows/e2e-trusted.yml),
  [`e2e-reusable.yml`](../.github/workflows/e2e-reusable.yml),
  [`pr-title.yml`](../.github/workflows/pr-title.yml),
  [`release.yml`](../.github/workflows/release.yml).
- Composite action:
  [`run-browserstack-maestro`](../.github/actions/run-browserstack-maestro).
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — local setup, commands, commit/PR/
  release conventions.
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — process model, IPC, lifecycle (what
  the native/e2e suites verify).
- [`build-architecture-plan.md`](./build-architecture-plan.md) — native-addon
  packaging and the fast-feedback story for module builds (§7 there).
- e2e gating design:
  [#139](https://github.com/digidem/comapeo-core-react-native/issues/139),
  [#142](https://github.com/digidem/comapeo-core-react-native/pull/142). Merge
  queue support: PR #136.
