# E2E Tests

End-to-end tests for `@comapeo/core-react-native` using [Maestro](https://maestro.mobile.dev/).

These tests run against the example app on an Android emulator (or device) and verify the full stack: React Native UI → native module → Unix domain socket IPC → embedded Node.js process.

## Prerequisites

1. **Android SDK** with an emulator AVD configured (API 34 recommended)
2. **Maestro CLI** — install with:
   ```bash
   curl -Ls "https://get.maestro.mobile.dev" | bash
   ```
3. **Node.js** (v18+) and **npm**

## Running tests

```bash
# From the repo root: build and run all tests
./e2e/run-e2e.sh

# Skip the build step (reuse last APK)
./e2e/run-e2e.sh --skip-build

# Run a single flow
./e2e/run-e2e.sh app-launch.yaml

# Or from the example/ directory
cd example && npm run e2e:android
```

The runner script will:
1. Check that `adb` and `maestro` are installed
2. Boot an emulator if no device is connected
3. Build the example app (unless `--skip-build`)
4. Install the APK
5. Run all Maestro flows in `.maestro/`

## Test flows

| Flow | What it tests |
|---|---|
| `app-launch.yaml` | App launches and displays all UI sections |
| `state-transitions.yaml` | Node.js process transitions through `started` → `ready` |
| `node-process-starts.yaml` | Node.js process reaches `ready` state within timeout |
| `ipc-roundtrip.yaml` | Sends 1000 messages and verifies all echoes return |
| `send-multiple-rounds.yaml` | Multiple rounds of IPC messaging work without channel degradation |

## Writing new tests

Create a new `.yaml` file in `e2e/.maestro/`. Test elements are identified by `testID` props on React Native components:

- `header` — main title
- `state-value` — current Node.js process state text
- `send-button` — sends 1000 benchmark messages
- `benchmark-result` — shows "Received 1000 messages in Xms"
- `render-count` — current render count

See [Maestro docs](https://maestro.mobile.dev/api-reference/commands) for available commands.

## CI

To run in CI (e.g. GitHub Actions), you need a Linux runner with KVM support for the Android emulator. See [reactivecircus/android-emulator-runner](https://github.com/ReactiveCircus/android-emulator-runner) for a GitHub Action that handles emulator setup.

Example workflow snippet:

```yaml
- uses: mobile-dev-inc/action-maestro-cloud@v1
  with:
    api-key: ${{ secrets.MAESTRO_CLOUD_API_KEY }}
    app-file: example/android/app/build/outputs/apk/debug/app-debug.apk
    workspace: e2e/.maestro
```
