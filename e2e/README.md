# E2E & Integration Tests

Tests for `@comapeo/core-react-native`, organized into three layers:

| Layer | Framework | Requires device? | What it tests |
|---|---|---|---|
| **JVM unit tests** | JUnit 4 | No | Message framing protocol, encoding correctness |
| **Instrumented tests** | AndroidJUnit4 + UiAutomator | Yes | IPC, service lifecycle, shutdown/recovery, file watching |
| **UI flows** | Maestro | Yes | Full-stack UI flows (app launch, messaging, state) |

## Prerequisites

1. **Android SDK** with an emulator AVD configured (API 34 recommended)
2. **Node.js** (v18+) and **npm**
3. **Maestro CLI** (for UI flows only) — install with:
   ```bash
   curl -Ls "https://get.maestro.mobile.dev" | bash
   ```

## Running tests

### All instrumented + unit tests

```bash
# Build and run all tests on device/emulator
./e2e/run-instrumented-tests.sh

# Skip the build step
./e2e/run-instrumented-tests.sh --skip-build

# Run a single test class
./e2e/run-instrumented-tests.sh --class NodeJSIPCTest

# Run a single test method
./e2e/run-instrumented-tests.sh --class NodeJSIPCTest#sendsMessageWithCorrectFraming

# JVM unit tests only (no device needed)
./e2e/run-instrumented-tests.sh --unit-only
```

### Maestro UI flows

```bash
./e2e/run-e2e.sh                     # build + run all flows
./e2e/run-e2e.sh --skip-build        # reuse last APK
./e2e/run-e2e.sh app-launch.yaml     # single flow
```

## Test structure

```
android/src/test/java/com/comapeo/core/      # JVM unit tests (no device)
  MessageFramingTest.kt     # Length-prefix protocol encoding/decoding

android/src/androidTest/java/com/comapeo/core/  # Instrumented tests (device)
    NodeJSIPCTest.kt        # IPC: connect, send, receive, framing, disconnect
    ServiceLifecycleTest.kt # Service: start, stop, process isolation, notification
    ShutdownPathTest.kt     # Shutdown: graceful stop, process kill, recovery cycles

e2e/.maestro/                                # Maestro UI flows
    app-launch.yaml         # App launches and displays all UI sections
    state-transitions.yaml  # Node.js transitions: started → ready
    node-process-starts.yaml# Node.js reaches ready within timeout
    ipc-roundtrip.yaml      # 1000 message echo round-trip
    send-multiple-rounds.yaml # Multiple rounds stay healthy
```

## Instrumented test details

### NodeJSIPCTest

Tests the `NodeJSIPC` class in isolation using a mock `LocalServerSocket`. No real Node.js process needed.

| Test | What it verifies |
|---|---|
| `connectsToExistingSocket` | Connects to an already-listening server |
| `sendsMessageWithCorrectFraming` | 4-byte LE length prefix + UTF-8 payload |
| `receivesMessageWithCorrectFraming` | Correctly reads length-prefixed frames |
| `handlesRoundTripEcho` | Send → server echoes → receive matches |
| `handlesMultipleMessages` | 100 messages sent and echoed correctly |
| `handlesLargeMessages` | 64KB message (exceeds 1KB reuse buffer) |
| `waitsForSocketFileCreation` | Connects after delayed socket file creation |
| `disconnectClosesCleanly` | No crash on disconnect |
| `handlesServerDisconnect` | Handles server closing its end |

### ServiceLifecycleTest

Tests the `ComapeoCoreService` via intents and system APIs.

| Test | What it verifies |
|---|---|
| `userForegroundStartsService` | USER_FOREGROUND intent starts service |
| `serviceRunsInSeparateProcess` | :ComapeoCore process exists |
| `stopActionStopsService` | STOP intent shuts down service + process |
| `userBackgroundDoesNotStopService` | USER_BACKGROUND keeps service alive |
| `serviceRestartsAfterProcessKill` | START_STICKY restarts after `kill` |
| `socketFilesCreatedOnStart` | comapeo.sock + state.sock exist |
| `socketFilesCleanedUpOnStop` | Socket files deleted on stop |
| `doubleStartIsIdempotent` | Second USER_FOREGROUND is no-op |
| `notificationExistsWhileRunning` | Foreground notification visible |

### ShutdownPathTest

Tests the critical shutdown and recovery path.

| Test | What it verifies |
|---|---|
| `stopActionTriggersGracefulShutdown` | STOP → Node.js shutdown → process exit |
| `processKillAndRecoveryPreservesNoSocketLeaks` | Kill → restart → sockets recreated |
| `notificationStopActionStopsService` | Same path as notification Stop button |
| `stopWhileNodeJSIsStartingDoesNotHang` | STOP during startup doesn't hang |
| `multipleStopStartCycles` | 3 start/stop cycles work (fresh process each) |
| `appForceStopCleansUpService` | `am force-stop` kills both processes |

## Writing new tests

### Instrumented tests

Add new test classes to `android/src/androidTest/java/com/comapeo/core/`. Use `@RunWith(AndroidJUnit4::class)` and the standard AndroidX Test APIs.

For service interaction, send intents directly rather than going through UI:

```kotlin
val intent = Intent().apply {
    setClassName(PACKAGE_NAME, SERVICE_CLASS)
    action = Actions.USER_FOREGROUND.name
}
context.startForegroundService(intent)
```

For process-level operations, use `UiDevice.executeShellCommand()`:

```kotlin
device.executeShellCommand("am kill $PACKAGE_NAME:ComapeoCore")
```

### Maestro flows

Create a `.yaml` file in `e2e/.maestro/`. Available testIDs:

- `header`, `state-value`, `send-button`, `benchmark-result`, `render-count`

## CI

For CI (GitHub Actions), you need a Linux runner with KVM support:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 18
      - run: npm install
      - run: cd example && npm install

      # JVM unit tests (no emulator needed)
      - run: ./e2e/run-instrumented-tests.sh --unit-only

      # Instrumented tests
      - uses: reactivecircus/android-emulator-runner@v2
        with:
          api-level: 34
          target: google_apis
          arch: x86_64
          script: ./e2e/run-instrumented-tests.sh --skip-build

      # Maestro UI flows
      - uses: mobile-dev-inc/action-maestro-cloud@v1
        with:
          api-key: ${{ secrets.MAESTRO_CLOUD_API_KEY }}
          app-file: example/android/app/build/outputs/apk/debug/app-debug.apk
          workspace: e2e/.maestro
```
