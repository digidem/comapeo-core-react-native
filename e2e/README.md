# Local test runners

Helper scripts for running this module's Android native tests and the local
Maestro UI flows against an emulator.

> For the full testing architecture — every layer, the CI workflows, the merge
> queue and required checks, the BrowserStack e2e, and the secrets/trust model —
> see [`docs/TESTING.md`](../docs/TESTING.md). This README only covers the local
> helper scripts in this directory.

These scripts drive the **integration app** (`apps/integration`). The device
end-to-end suite CI runs on BrowserStack uses a *separate* app (`apps/e2e`) and
the flow in `maestro/e2e.yaml` — not the scripts here.

## Prerequisites

- Node.js 24 (see [`.nvmrc`](../.nvmrc)) and npm.
- Android SDK with an emulator AVD (API 30+).
- For the Maestro flows only: the Maestro CLI —
  `curl -Ls "https://get.maestro.mobile.dev" | bash`.

## JVM unit + instrumented tests — `run-instrumented-tests.sh`

Builds the integration app (`expo prebuild` into `apps/integration/android`),
then runs the module's JVM unit tests and the instrumented (emulator) tests via
Gradle.

```bash
./e2e/run-instrumented-tests.sh                       # build + run all on a device/emulator
./e2e/run-instrumented-tests.sh --skip-build          # reuse the last build
./e2e/run-instrumented-tests.sh --unit-only           # JVM unit tests only (no device)
./e2e/run-instrumented-tests.sh --class NodeJSIPCTest # one class (a Class#method filter also works)
```

Test sources (the source of truth — the per-test tables that used to live here
drifted, so read the directories instead):

- **JVM unit** — `android/src/test/java/com/comapeo/core/`
- **Instrumented** — `android/src/androidTest/java/com/comapeo/core/`, plus the
  service-lifecycle suites under `apps/integration/tests/android/` that the
  `with-android-tests` config plugin re-injects into the prebuilt project.

## Maestro UI flows (Android, local) — `run-e2e.sh`

Builds the integration app, boots an emulator if needed, installs the APK, and
runs the Maestro flows in [`e2e/.maestro/`](./.maestro):

```bash
./e2e/run-e2e.sh                  # build + run all flows
./e2e/run-e2e.sh --skip-build     # reuse the last APK
./e2e/run-e2e.sh app-launch.yaml  # a single flow (resolved against e2e/.maestro/)
```

The flows assert on the integration app's testIDs (`header`, `state-value`,
`send-button`, `benchmark-result`, `render-count`). **iOS UI flows don't run
locally** — the backend needs a keychain entitlement the simulator can't grant,
so iOS e2e runs on BrowserStack only (see [`docs/TESTING.md`](../docs/TESTING.md)).
