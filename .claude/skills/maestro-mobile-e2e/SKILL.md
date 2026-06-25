---
name: "maestro-mobile-e2e"
description: >-
  Write and run Maestro UI e2e flows for mobile apps locally and in GitHub
  Actions CI. Covers install, device setup, flow YAML syntax, config.yaml,
  running/debugging flows, Expo/React Native handling (dev menu & LogBox
  overlays, testID, dev-client vs release builds), and CI pipelines. Use when
  the user mentions "Maestro", "maestro test", "maestro flow", ".maestro",
  "e2e flow", "UI test", or working with files under a `maestro/` or
  `.maestro/` directory. Local + GitHub CI only — for real-device runs on
  BrowserStack see the browserstack-app-automate-maestro skill; this skill does
  NOT cover Maestro Cloud or Maestro Studio.
---

# Maestro mobile e2e — local + GitHub CI

Maestro drives a real app on a device/emulator from a YAML flow: launch the
app, tap/assert on UI elements, wait for content. One flow = one `.yaml` file.
This skill is for **local iteration** and **GitHub Actions CI**. It deliberately
omits Maestro Cloud and Maestro Studio.

Maestro does **not** build or install the app — the app under test must already
be installed on a booted device/simulator. Flows reference it by `appId` and
start it with `launchApp`.

## Install & environment

```bash
curl -fsSL "https://get.maestro.mobile.dev" | bash   # macOS / Linux / WSL
```

The documented host is `get.maestro.mobile.dev` (`get.maestro.dev` also
resolves). Installs a self-contained CLI to `~/.maestro` and adds
`~/.maestro/bin` to PATH via your shell profile — restart the shell after.
Verify with `maestro --version`.

- **Java 17+ is required** (17 or 21 recommended; very old/new JDKs cause odd
  failures). Set `JAVA_HOME`. On WSL: `sudo apt install openjdk-17-jdk`.
- **macOS / Homebrew:** `brew tap mobile-dev-inc/tap && brew install mobile-dev-inc/tap/maestro`. iOS needs Xcode + Command Line Tools.
- **Windows (no WSL):** download `maestro.zip` from the GitHub releases, extract, add `bin` to PATH. WSL works but the docs advise against it (ADB/port-forward pain).
- **Pin the version** for reproducible CI — the install script honours `MAESTRO_VERSION`:
  ```bash
  export MAESTRO_VERSION=1.39.0; curl -Ls "https://get.maestro.mobile.dev" | bash
  ```

Useful env vars (set the first three in CI):

| Var | Default | Effect |
|---|---|---|
| `MAESTRO_VERSION` | latest | which CLI version the install script fetches |
| `MAESTRO_CLI_NO_ANALYTICS` | false | disable analytics |
| `MAESTRO_DISABLE_UPDATE_CHECK` | false | skip the "newer version" network check |
| `MAESTRO_DRIVER_STARTUP_TIMEOUT` | 15000 (ms) | how long to wait for the on-device driver to start — **raise it for cold CI emulators** |

## Device setup (local)

Maestro auto-detects a single booted emulator/simulator. With more than one
device, target it with the **global** `--device`/`--udid` flag placed *before*
the subcommand.

```bash
adb devices                              # Android device IDs
xcrun simctl list devices booted         # iOS simulator UDIDs
maestro list-devices                     # cross-platform

maestro start-device --platform android  # boots Pixel 6 / API 30 by default
maestro start-device --platform ios      # boots iPhone 11 / iOS 15.5 by default

maestro --device emulator-5554 test flow.yaml
maestro --device <SIM-UUID>   test flow.yaml
```

`maestro hierarchy` dumps the current screen's element tree — the local way to
discover selectors (text, `id`) without Studio.

## Flow file structure

A flow is an optional header, a `---` separator, then an ordered command list.
Maestro auto-waits for the UI to settle between commands — explicit sleeps are
rarely needed.

```yaml
appId: com.example.app          # iOS bundle id / Android package — the only required field
name: Login smoke               # shown in reports
tags: [smoke, regression]       # filter with --include-tags / --exclude-tags
env:
  TIMEOUT: 30000                # constants, referenced as ${TIMEOUT}
onFlowStart:                    # runs before the main commands
  - launchApp
onFlowComplete:                 # runs after — teardown that must always run
  - killApp
---
- tapOn: "Login"
- assertVisible: "Welcome"
```

### Commands worth knowing

```yaml
- launchApp:
    clearState: true            # wipe app data first; OMIT to keep state
    clearKeychain: true         # iOS only — clears the WHOLE iOS keychain
    stopApp: false              # false = foreground a backgrounded app w/o restart
    permissions: { all: deny }  # allow | deny | unset; or name specific permissions
    arguments: { debugMode: true }
- stopApp                       # graceful stop (Android: am force-stop) — kills the process
- killApp                       # force kill
- clearState                    # clear data without launching

- tapOn: "Button"               # shorthand = text selector (regex-matched)
- tapOn: { id: "login_button", index: 0 }
- doubleTapOn: "Item"
- longPressOn: "Item"

- inputText: ${USERNAME}
- inputRandomEmail
- eraseText: { charactersToErase: 5 }   # omit to erase all
- copyTextFrom: { id: "userName" }      # → ${maestro.copiedText}
- pressKey: Enter
- hideKeyboard
- back
- openLink: myapp://deeplink

- scroll
- scrollUntilVisible:
    element: { text: "Target" }
    direction: DOWN
    timeout: 10000
- swipe: { direction: LEFT, duration: 500 }

- assertVisible: "Expected"
- assertVisible: { id: "checkbox", checked: true, timeout: 5000 }
- assertNotVisible: "Absent"
- assertTrue: ${output.count > 0}

- waitForAnimationToEnd
- extendedWaitUntil:            # the explicit "wait until X appears" — use for slow ops
    visible: { id: "done" }
    timeout: 60000             # ms; also supports notVisible:

- takeScreenshot: "name"        # artifact for CI / debugging
- setLocation: { latitude: 37.77, longitude: -122.41 }
```

### Selectors

Any element command accepts the same selector object; a bare string is a `text`
selector. **Text and `id` are matched as regular expressions** — escape `$`,
`[`, etc. with a backslash.

```yaml
- tapOn: { text: ".*Continue.*" }
- tapOn: { id: "submit", index: 2 }      # 0-based, pick among duplicates
- tapOn: { point: "50%, 50%" }           # relative coords; or "100, 250" absolute px
- tapOn: { below: "Email" }              # relational: below/above/leftOf/rightOf
- tapOn: { containsChild: { text: "Order 12345" } }
- assertVisible: { id: "box", checked: true }   # state: enabled/checked/selected/focused
- tapOn: { text: "Allow", optional: true }      # skip instead of fail if absent
```

### Conditions, loops, retries

`when` gates a command (usually `runFlow`). Keys: `visible`, `notVisible`,
`platform` (Android/iOS/Web), `true` (a JS expression). Multiple keys = AND.

```yaml
- runFlow:
    when: { platform: Android, visible: "Allow Notifications" }
    commands:
      - tapOn: "Allow"

- repeat:
    times: 10                   # times and/or while; both = bounded loop
    while: { visible: "Update available" }
    commands:
      - tapOn: "Dismiss"

- retry:
    maxRetries: 3               # 0–3. Don't wrap large flows — it hides real flakiness
    commands:
      - tapOn: { id: "flaky-button" }
      - assertVisible: "Loaded"
```

### Variables & JavaScript

Sources: the header `env` block, `-e KEY=VALUE` CLI flags (values arrive as
**strings**), and `env` under a `runFlow` (overrides parent). Interpolate with
`${...}`, which evaluates JavaScript (`${USERNAME || "guest"}`). The global
`output` object persists across all commands and scripts in a flow.

```yaml
- evalScript: ${output.token = "abc"}   # inline JS, logic only
- runScript:
    file: scripts/setupUser.js          # external .js; env values referenced by bare name
    env: { userRole: "admin" }
- inputText: ${output.result}
```

Scripts get an `http` client (`http.post(url, { headers, body })` → `{ ok,
status, body, headers }`) — handy for seeding state via an API before a flow.
`console.log` takes a single argument; use template literals.

### Shared setup via subflows

```yaml
- runFlow:
    file: ../common/login.yaml
    env: { USERNAME: "myUser", PASSWORD: "secret" }
```

Keep each subflow atomic and parameterized through `env`. Combine with `when`
to run setup only on a given platform or when an element is/isn't present.

## config.yaml (workspace)

Lives at the workspace root or in a `.maestro/` dir, named `config.yaml`. Pick a
non-default file with `maestro test --config=pr-config.yaml`.

```yaml
flows:
  - "subFolder/*"               # default '*' = root-level YAML only; use '**' to recurse
includeTags: [smoke]
excludeTags: [wip]
executionOrder:                 # by default flows run in ARBITRARY order
  continueOnFailure: false
  flowsOrder: [flowA, flowB]    # filename without .yaml, or the flow's `name`
```

`maestro test <dir>` only discovers root-level YAML unless `flows:` globs widen
it with `**`.

## Running flows locally

```bash
maestro test flow.yaml
maestro test maestro/                          # a folder of flows
maestro test -c flow.yaml                       # watch mode: rerun on save (tight loop)
maestro test flow.yaml -e USERNAME=alice -e TIMEOUT=30000
maestro test maestro/ --include-tags=smoke --exclude-tags=wip
maestro test flow.yaml --debug-output ./debug   # logs + screenshots on failure
maestro test maestro/ --format junit --output report.xml
```

When a flow fails, the debug output dir (default under `~/.maestro/tests/`,
or `--debug-output`) holds the commands log, screenshots, and the view
hierarchy at the point of failure — read those first.

## Expo / React Native

This is where most flakiness comes from. Read this section before debugging a
"works in the app, fails in Maestro" report.

### testID → `id`

React Native `testID` maps to Maestro's `id` selector:

```jsx
<TextInput testID="passwordInput" />
```
```yaml
- tapOn: { id: "passwordInput" }
```

Put stable `testID`s on every interactive element — text selectors break when
copy changes. iOS gotcha: with nested tappable elements, enable accessibility
on the inner element and disable it on the outer container, or taps miss.

### Dev menu & LogBox overlays — the main pitfall

In a **development build**, the React Native dev menu, the LogBox red/yellow
error overlays, the Reload/fast-refresh overlay, and React Native DevTools can
all appear mid-test and intercept taps. They are **all disabled in a
release/production build**. So:

- **Best fix: test against a release/preview build** (or a dev-client build with
  no overlays triggered). Overlays simply don't exist there. There is **no
  `EXPO_NO_*` env var** to disable the dev menu — what controls it is whether
  `expo-dev-client` is present and whether it's a Release build.
- **When you must test a dev build**, dismiss overlays defensively in-flow with
  `optional: true` taps before interacting, e.g. an Expo dev-launcher onboarding
  overlay:
  ```yaml
  - launchApp
  - tapOn: { text: "Continue", optional: true }   # clears the fresh-install overlay; no-op otherwise
  - tapOn: "Run tests"
  ```

### appId

`appId` = iOS `bundleIdentifier` / Android `package` from `app.json`
(`ios.bundleIdentifier`, `android.package`). Parameterize it if a flow runs
against more than one build:

```yaml
appId: ${APP_ID}
---
- launchApp
```
```bash
maestro test -e APP_ID=com.example.app maestro/flow.yaml
```

### Building a testable build

- **Local, overlay-free:** `expo run:android --variant release` /
  `expo run:ios --configuration Release`.
- **EAS** — a dedicated profile in `eas.json` produces a sim `.app` / `.apk`:
  ```json
  { "build": { "e2e-test": {
      "withoutCredentials": true,
      "ios": { "simulator": true },
      "android": { "buildType": "apk" } } } }
  ```
  Then `adb install app.apk` (Android) / `xcrun simctl install booted app.app`
  (iOS) before `maestro test`.
- **Avoid Expo Go** for serious e2e: you can't `launchApp` a custom `appId`
  there — you'd have to `openLink: exp://127.0.0.1:19000`. Use a dev-client or
  standalone build.

### Dev-client local loop (Metro, no rebuild)

A dev-client build can run a flow against a Metro dev server, so you iterate on
JS without rebuilding the native app. The catch: `launchApp` with no URL just
reconnects the dev client to whatever Metro it last used — which may be a
different project's. Point it at the right Metro once per simulator, then run:

```bash
cd apps/e2e && npx expo start --port 8081           # start this project's Metro
xcrun simctl openurl booted \
  "exp+<slug>://expo-development-client/?url=http://localhost:8081"
# confirm the app loads, then:
maestro test maestro/flow.local.yaml
```

Do **not** `clearState` in the local variant — it wipes the dev launcher's saved
Metro URL. Keep a separate `*.local.yaml` flow that drops `clearState` and adds
the optional overlay-dismiss tap; mirror its assertions with the CI flow.

## GitHub Actions CI

There is **no official Maestro GitHub Action for non-cloud runs** — install the
CLI and run `maestro test` against a runner-provided emulator/simulator
yourself. Pin `MAESTRO_VERSION`, silence analytics/update checks, emit JUnit,
and upload artifacts with `if: always()`.

### Android (community `reactivecircus/android-emulator-runner`)

The emulator is only alive inside the action's `script:`. Build/install the app
there too. **Use a macOS runner** for hardware acceleration (ubuntu with nested
virtualization works but macOS is the safe default).

```yaml
jobs:
  e2e:
    runs-on: macos-latest
    env:
      MAESTRO_VERSION: "1.39.0"
      MAESTRO_CLI_NO_ANALYTICS: "true"
      MAESTRO_DISABLE_UPDATE_CHECK: "true"
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with: { distribution: temurin, java-version: "17" }
      - name: Install Maestro
        run: |
          curl -Ls "https://get.maestro.mobile.dev" | bash
          echo "$HOME/.maestro/bin" >> "$GITHUB_PATH"
      # ... build a release APK, e.g. ./gradlew assembleRelease ...
      - uses: reactivecircus/android-emulator-runner@v2
        with:
          api-level: 30
          arch: x86_64
          target: google_apis
          emulator-options: -no-window -gpu swiftshader_indirect -no-snapshot -no-boot-anim -camera-back none
          script: |
            adb install -r app/build/outputs/apk/release/app-release.apk
            maestro test --format junit --output report.xml --no-ansi maestro/
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: maestro-results
          path: |
            report.xml
            ~/.maestro/tests/**
```

### iOS (macOS runner)

Needs Xcode Command Line Tools and a booted simulator (community
`futureware-tech/simulator-action@v2` boots one). Install Maestro the same way,
`xcrun simctl install booted App.app`, then `maestro test`.

### CI tips

- `--no-ansi` keeps logs clean; `--flatten-debug-output` puts all artifacts in
  one folder so the upload glob is simple.
- A flow that needs a backend API can seed state via the `http` client in
  `runScript` rather than a live network round-trip.
- For real-device coverage this project runs flows on **BrowserStack**, not a
  CI emulator — see the `browserstack-app-automate-maestro` skill and
  `.github/actions/run-browserstack-maestro/`.

## Flakiness & timing

- Maestro auto-waits for content/animations between commands — reach for
  `extendedWaitUntil` for genuinely slow operations, not blind sleeps.
- Cold CI emulators: raise `MAESTRO_DRIVER_STARTUP_TIMEOUT` if the driver
  handshake times out before the device is ready.
- iOS `hideKeyboard` doesn't always dismiss — tap a non-interactive `point:`
  instead.
- Don't paper over real flakiness with `retry` around a whole flow; scope it to
  the one command that races, and prefer fixing the missing wait.
- Distinguish **infra flakes** (driver connection reset, app-install failure,
  session never started) from **real failures** (a failed assertion). Only retry
  the former — see how `run-browserstack-maestro/action.yml` classifies them.

## This project (comapeo-core-react-native)

The e2e app lives in `apps/e2e` (Expo dev-client, `appId`
`com.comapeo.core.e2e`). The app renders an in-app test harness: tap
**"Run tests"**, wait for the `all-tests-done` testID, assert `all-tests-passed`.
Flows live in `maestro/`:

- `maestro/e2e.yaml` — CI/BrowserStack flow, standalone build, real device.
  Launches with `clearState: true`.
- `maestro/e2e.local.yaml` — local simulator variant against a Metro dev server.
  No `clearState` (would wipe the dev launcher's Metro URL); adds the optional
  "Continue" overlay-dismiss tap. Keep its "Run tests" / `all-tests-*` steps in
  sync with `e2e.yaml`.
- `maestro/fgs-restart.yaml` — asserts the `:ComapeoCore` foreground service
  recovers after `stopApp` kills its process, relaunching without `clearState`.

The CI path builds the app, uploads the binary to BrowserStack, and runs the
flow there (`.github/workflows/e2e-*.yml` → `run-browserstack-maestro`), not on
a CI emulator. For BrowserStack mechanics use the
`browserstack-app-automate-maestro` skill.
