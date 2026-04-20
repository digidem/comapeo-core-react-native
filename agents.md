# @comapeo/core-react-native

An Expo module that integrates [CoMapeo Core](https://github.com/digidem/comapeo-core) into React Native applications. It runs CoMapeo Core in an embedded Node.js process and communicates with the React Native layer over IPC using Unix domain sockets.

## What is CoMapeo?

[CoMapeo](https://comapeo.app/) is a local-first, peer-to-peer mapping and territorial monitoring tool built by [Awana Digital](https://awana.digital/) (formerly Digital Democracy) in collaboration with Indigenous partners across the Amazon, East Africa, Southeast Asia, and the Pacific. It is used by frontline environmental defenders in over 90 countries to map, monitor, and protect land and forest.

CoMapeo is the successor to [Mapeo](https://docs.mapeo.app/), rebuilt from scratch with encrypted peer-to-peer data storage, improved project management, GPS tracks, and a more maintainable architecture.

### CoMapeo ecosystem

| Package | Role |
|---|---|
| [`@comapeo/core`](https://github.com/digidem/comapeo-core) | Core library (Node.js) — `MapeoManager` API for projects, observations, sync |
| [`@comapeo/ipc`](https://github.com/digidem/comapeo-ipc) | IPC wrappers (`createMapeoServer` / `createMapeoClient`) for cross-context communication |
| **`@comapeo/core-react-native`** (this repo) | Expo module — runs `@comapeo/core` in an embedded Node.js thread |
| [`comapeo-mobile`](https://github.com/digidem/comapeo-mobile) | React Native mobile app |
| [`comapeo-desktop`](https://github.com/digidem/comapeo-desktop) | Electron desktop app |
| [`comapeo-cloud`](https://github.com/digidem/comapeo-cloud) | Self-hosted cloud server |

This module is the bridge that lets `comapeo-mobile` use `@comapeo/core` (a Node.js library) from within React Native. In production, the Node.js entry point would initialize a `MapeoManager` and wrap it with `createMapeoServer` from `@comapeo/ipc`, while the React Native side would use `createMapeoClient` over the `messagePort` exported by this module. Currently, the embedded Node.js project contains a test scaffold that echoes messages back.

## Architecture overview

The module runs CoMapeo Core inside an embedded Node.js runtime and communicates with the React Native layer via length-prefixed JSON messages over Unix domain sockets. The process model differs per platform:

- **Android** uses a **dual-process** architecture: the UI runs in the main app process and Node.js runs in a separate `:ComapeoCore` foreground service process.
- **iOS** runs Node.js **in-process** on a dedicated thread (via `nodejs-mobile`'s `NodeMobileStartNode`). iOS has no foreground-service equivalent, so graceful shutdown is driven by UIKit lifecycle events and `UIApplication.beginBackgroundTask`.

```
┌──────────────────────────────────────────┐
│  React Native (JavaScript)               │
│  messagePort.postMessage() / addListener │
└──────────────┬───────────────────────────┘
               │ Expo Modules (JSI)
┌──────────────▼───────────────────────────┐
│  Native Module (Kotlin / Swift)          │
│  ComapeoCoreModule                       │
└──────────────┬───────────────────────────┘
               │ Unix Domain Sockets
               │ (length-prefixed JSON frames)
┌──────────────▼───────────────────────────┐
│  Node.js Process (separate OS process)   │
│  CoMapeo Core + socket servers           │
│  - comapeo.sock  (main RPC channel)      │
│  - state.sock    (control/state channel) │
└──────────────────────────────────────────┘
```

### IPC protocol

Messages are framed with a **4-byte little-endian length prefix** followed by a UTF-8 JSON payload. Both sides use this same protocol. On Android the Kotlin `NodeJSIPC` class implements the client side; on iOS the Swift `NodeJSIPC` class implements the same protocol. On the Node.js side, the `SocketMessagePort` class (wrapping `framed-stream`) implements the server side.

### Two socket channels

| Socket | Purpose |
|---|---|
| `comapeo.sock` | Main RPC channel for application data (maps to `messagePort` in JS) |
| `state.sock` | Control channel for lifecycle signals (started, ready, shutdown) |

## Directory structure

```
├── src/                          # TypeScript source (React Native side)
│   ├── index.ts                  # Public API exports
│   ├── ComapeoCoreModule.ts      # MessagePort + State wrappers around native module
│   └── ComapeoCore.types.ts      # Type definitions for events and payloads
│
├── android/
│   ├── src/main/java/com/comapeo/core/
│   │   ├── ComapeoCoreModule.kt                       # Expo module definition
│   │   ├── ComapeoCoreService.kt                      # Android foreground service
│   │   ├── NodeJSService.kt                           # JNI wrapper for Node.js
│   │   ├── NodeJSIPC.kt                               # Unix socket IPC client
│   │   ├── ComapeoCoreReactActivityLifecycleListener.kt  # Activity lifecycle hooks
│   │   ├── ComapeoCorePackage.kt                      # Expo package registration
│   │   ├── Actions.kt                                 # Service action enum
│   │   ├── watchForFile.kt                            # Coroutine file watcher
│   │   └── log.kt                                     # Logging utility
│   ├── src/main/cpp/
│   │   ├── jni-bridge.cpp         # JNI bridge to libnode.so
│   │   ├── log.cpp / log.h        # C++ logcat helpers
│   ├── src/main/assets/nodejs-project/
│   │   ├── index.js               # Node.js entry point
│   │   └── lib/
│   │       ├── message-port.js    # SocketMessagePort (framed JSON over sockets)
│   │       ├── comapeo-rpc.js     # Main RPC server factory
│   │       ├── control-rpc.js     # Control RPC server factory
│   │       └── connection-manager.js  # Tracks and closes socket connections
│   ├── build.gradle               # Android build config (Kotlin, CMake, NDK)
│   └── CMakeLists.txt             # C++ build config
│
├── ios/
│   ├── ComapeoCoreModule.swift              # Expo module definition
│   ├── AppLifecycleDelegate.swift           # ExpoAppDelegateSubscriber, owns shared NodeJSService
│   ├── NodeJSService.swift                  # Runs Node.js on a dedicated thread, manages lifecycle
│   ├── NodeJSService+BackgroundTask.swift   # UIKit background-task wrapper around stop()
│   ├── NodeJSIPC.swift                      # Unix socket IPC client + waitForFile helper
│   ├── NodeMobileBridge.{h,mm}              # Obj-C bridge to NodeMobile.xcframework
│   ├── Log.swift                            # Logging utility
│   ├── Package.swift                        # Swift Package for unit + simulator tests
│   ├── ComapeoCore.podspec                  # CocoaPods spec
│   ├── nodejs-project/                      # Node.js source (shared with android via sync step)
│   └── Tests/                               # Swift Package test target (see Testing)
│       ├── Helpers/MockNodeServer.swift
│       ├── MessageFramingTests.swift
│       ├── WatchForFileTests.swift
│       ├── NodeJSIPCTests.swift
│       ├── NodeJSServiceTests.swift
│       └── IPCLifecycleTests.swift
│
├── example/                       # Example Expo app with benchmarks
│   ├── App.tsx                    # Sends 1000 messages, measures round-trip time
│   ├── android/app/src/androidTest/   # Instrumented integration tests (real service)
│   └── ios/corereactnativeexampleTests/  # XCTest integration tests (real Node.js runtime)
│
├── docs/
│   ├── Todos.md                   # Implementation TODO list
│   └── ForegroundService.md       # Android foreground service documentation
│
├── expo-module.config.json        # Expo module platform config
├── package.json                   # NPM package config
└── tsconfig.json                  # TypeScript config
```

## Key components

### React Native side (`src/`)

**`ComapeoCoreModule.ts`** — The main JS interface. Exports two singletons:

- **`messagePort`** — A `MessagePort` class (EventEmitter) for bidirectional communication with the Node.js process. Call `postMessage(jsonValue)` to send; listen for `"message"` events to receive. Handles JSON serialization/deserialization automatically.
- **`state`** — A `State` class (EventEmitter) that tracks the Node.js process state. Call `getState()` for current state; listen for `"stateChange"` events.

Both classes wrap the native module loaded via Expo's `requireNativeModule("ComapeoCore")`.

### Android native layer

#### ComapeoCoreModule (`ComapeoCoreModule.kt`)
The Expo module entry point. Creates a `NodeJSIPC` instance on module creation, forwards `postMessage()` calls to IPC, and emits received messages as events back to JavaScript. Manages lifecycle transitions (foreground/background) via `ComapeoCoreReactActivityLifecycleListener`.

#### ComapeoCoreService (`ComapeoCoreService.kt`)
An Android **foreground service** running in a separate process (`:ComapeoCore`). This is necessary because:
1. Android kills background processes aggressively
2. CoMapeo Core needs to keep syncing data even when the app is backgrounded
3. The foreground service type is `dataSync` (6-hour limit per 24h, resets on foreground)

State machine: `STOPPED → STARTING → STARTED → STOPPING → STOPPED`

Responds to three actions:
- `USER_FOREGROUND` — Start or resume the service
- `USER_BACKGROUND` — Update notification to show "Stop" action
- `STOP` — Gracefully shut down Node.js and the service

#### NodeJSService (`NodeJSService.kt`)
JNI wrapper that manages the embedded Node.js runtime. Responsibilities:
- Copies the `nodejs-project` assets from the APK to the filesystem (only on APK updates)
- Launches Node.js via JNI `startNodeWithArguments(["node", "index.js", "comapeo.sock", "state.sock"])`
- Sends `{"type":"shutdown"}` over `state.sock` for graceful shutdown

#### NodeJSIPC (`NodeJSIPC.kt`)
Unix domain socket IPC client using Kotlin coroutines. Key behaviors:
- Waits for socket file creation using `FileObserver`
- Connects with exponential backoff retry (100ms → 5s, 5 attempts)
- Reads/writes length-prefixed JSON frames
- Separate coroutines for send and receive
- Reuses fixed 1KB buffer for typical messages to reduce GC pressure

State machine: `Disconnected → Connecting → Connected → Disconnecting → Disconnected`

#### JNI Bridge (`jni-bridge.cpp`)
C++ layer between Kotlin and `libnode.so` (the embedded Node.js binary). Also redirects Node.js stdout/stderr to Android logcat with the tag `Comapeo:NodeJS`.

### Node.js side (`android/src/main/assets/nodejs-project/`)

**`index.js`** — Entry point that creates two socket servers:
1. `comapeoRpcServer` on `comapeo.sock` — Main RPC channel. Currently echoes messages back (test/scaffold behavior).
2. `stateIpcServer` on `state.sock` — Listens for `{"type":"shutdown"}` to trigger graceful shutdown. Sends `{"type":"started"}` and `{"type":"ready"}` events to connected clients.

**`lib/message-port.js`** — `SocketMessagePort` class that wraps a socket in `framed-stream` for length-prefixed JSON messaging. States: `idle → active → closed`.

**`lib/connection-manager.js`** — Tracks active socket connections and provides `closeAll()` for clean shutdown.

### iOS native layer

#### ComapeoCoreModule (`ComapeoCoreModule.swift`)
The Expo module entry point. On `OnCreate` it creates a `NodeJSIPC` pointed at the shared `NodeJSService`'s `comapeo.sock` and forwards `"message"` events to JavaScript. `Function("postMessage")` forwards calls to the IPC; `Function("getState")` reflects the service state; `"stateChange"` events are emitted from the shared `NodeJSService.onStateChange` callback.

#### AppLifecycleDelegate (`AppLifecycleDelegate.swift`)
An `ExpoAppDelegateSubscriber` that owns a **single static** `NodeJSService` (`_nodeService`). Node-mobile's `NodeMobileStartNode` can only be called once per process, so the service must be a process-wide singleton — Expo creates a fresh module instance per-test and tests also reference `AppLifecycleDelegate.shared.nodeService`, so the service is static to keep them pointing at the same instance. Lifecycle hooks:
- `applicationDidBecomeActive` — `nodeService.start()`
- `applicationDidEnterBackground` — `stopWithBackgroundTask(timeout: 10)`
- `applicationWillTerminate` — synchronous `stop(timeout: 5)`

#### NodeJSService (`NodeJSService.swift`)
Runs Node.js on a dedicated 2 MB-stack thread (required by nodejs-mobile). Responsibilities:
- Allocates `comapeo.sock` and `state.sock` under `filesDir` (currently `/tmp/comapeo` — short path needed to fit inside the 104-byte `sockaddr_un.sun_path` limit).
- Opens a `NodeJSIPC` against `state.sock` for lifecycle/control messages.
- Calls the `NodeEntryPoint` closure (blocking call into `NodeMobileStartNode`) on the node thread.
- On `stop()`, sends `{"type":"shutdown"}` over `state.sock` and waits on a completion semaphore signalled by the node thread's exit.

State machine: `STOPPED → STARTING → STARTED → STOPPING → STOPPED` with an additional `ERROR` state.

`NodeEntryPoint` and `resolveJSEntryPoint` are injected so tests can substitute a blocking-semaphore fake for the real `NodeMobileStartNode` call.

#### NodeJSService+BackgroundTask (`NodeJSService+BackgroundTask.swift`)
UIKit-specific extension. Wraps `stop(timeout:)` inside `UIApplication.beginBackgroundTask(...)` so iOS grants extra execution time for graceful shutdown when the app backgrounds. Kept separate from `NodeJSService.swift` so the Swift Package target can build without UIKit.

#### NodeJSIPC (`NodeJSIPC.swift`)
Unix domain socket IPC client using `Darwin.socket`/`connect`/`read`/`write` with GCD queues. Key behaviors:
- Waits for socket file creation with `waitForFile(atPath:timeoutSeconds:)` (50 ms polling — a `FileObserver` equivalent is not used).
- Connects with exponential backoff (100 ms → 5 s, 5 attempts).
- Reads/writes length-prefixed JSON frames.
- `sendMessage` dispatches to a serial send queue; `sendMessageSync` is used during shutdown to guarantee the shutdown frame is written before the node thread exits.
- `socket` is `internal` (not `private`) so tests can toggle `SO_SNDBUF`/`O_NONBLOCK` to exercise partial-write paths.

State machine: `disconnected → connecting → connected → disconnecting → disconnected` (plus `error`).

#### NodeMobileBridge (`NodeMobileBridge.{h,mm}`)
Obj-C bridge exposing `NodeMobileStartNode` from the `NodeMobile.xcframework` to Swift.

### iOS Node.js project

The Node.js source lives at `ios/nodejs-project/` and mirrors `android/src/main/assets/nodejs-project/`. Both platforms run the same `index.js` + `lib/` files. The iOS build bundles the directory into the app bundle; `resolveJSEntryPoint` resolves `nodejs-project/index.js` via `Bundle.main.path(...)`.

## Data flow

### Sending a message from React Native to Node.js

1. `messagePort.postMessage({ key: "value" })` — JS serializes to JSON string
2. `ComapeoCoreModule.postMessage(jsonString)` — Expo JSI call to native
3. `NodeJSIPC.sendMessage(jsonString)` — Encodes as 4-byte length prefix + UTF-8 bytes
4. Written to `comapeo.sock` Unix domain socket
5. Node.js `SocketMessagePort` receives via `framed-stream`, parses JSON, emits `"message"` event

### Receiving a message from Node.js in React Native

1. Node.js `messagePort.postMessage(value)` — Writes length-prefixed JSON to socket
2. `NodeJSIPC` receive coroutine reads length prefix, then message bytes
3. Calls `onMessage` callback with raw string
4. `ComapeoCoreModule` emits `"message"` event via Expo modules
5. `MessagePort.#handleMessageEvent` parses JSON and emits `"message"` to JS listeners

## Platform status

| Platform | Status | Notes |
|---|---|---|
| Android | Functional | Full implementation with foreground service, JNI, IPC |
| iOS | Functional (in progress) | In-process Node.js via `nodejs-mobile`, IPC, graceful shutdown; several behavioral gaps covered by failing tests — see Testing |
| Web | Not started | Declared in expo-module.config.json but no implementation |

## Testing

### Android

| Layer | Tool | Location |
|---|---|---|
| JVM unit tests | JUnit4 | `android/src/test/java/com/comapeo/core/` |
| Instrumented IPC/file-watch tests | AndroidJUnit4 | `android/src/androidTest/java/com/comapeo/core/` |
| Service lifecycle integration tests | AndroidJUnit4 on example app | `example/android/app/src/androidTest/java/com/comapeo/core/example/` |
| Local runner | Shell script | `e2e/run-instrumented-tests.sh` |
| CI | `.github/workflows/android-tests.yml` | |

### iOS

| Layer | Tool | Location | How it's run |
|---|---|---|---|
| Framing unit tests | `swift test` (no simulator) | `ios/Tests/MessageFramingTests.swift` | Unit-tests CI job, `swift test --filter MessageFramingTests` |
| Package integration tests (mocked Node.js) | `xcodebuild test` on `ComapeoCore-Package` | `ios/Tests/` (all other files) | Simulator-tests CI job |
| Example app integration tests (real Node.js) | `xcodebuild test` on `corereactnativeexample` workspace | `example/ios/corereactnativeexampleTests/` | Integration-tests CI job |
| CI | `.github/workflows/ios-tests.yml` | | |

#### What each iOS layer covers

- **`ios/Tests/`** is a Swift Package test target (see `ios/Package.swift`). It builds only the platform-portable files (`NodeJSIPC.swift`, `NodeJSService.swift`, `Log.swift`) — UIKit-dependent files are excluded so the package compiles for both macOS and iOS Simulator.
  - `MessageFramingTests` — pure framing-protocol unit tests, no sockets.
  - `WatchForFileTests` — tests the `waitForFile` helper directly.
  - `NodeJSIPCTests` — connects `NodeJSIPC` to a real Unix domain socket via `MockNodeServer` (no Node.js required).
  - `NodeJSServiceTests` — drives `NodeJSService` with a mock `NodeEntryPoint` that blocks on a `DispatchSemaphore` until signalled, simulating the node runtime without calling `NodeMobileStartNode`.
  - `IPCLifecycleTests` — wires `NodeJSService` + `NodeJSIPC` + `MockNodeServer` for end-to-end mocked lifecycle scenarios.
  - `Helpers/MockNodeServer.swift` — shared Unix-socket mock server used across the last three files.

- **`example/ios/corereactnativeexampleTests/`** runs against the **real** `NodeMobileStartNode` inside the example app target.
  - `ComapeoCoreModuleTests` — verifies two testable seams on `ComapeoCoreModule` (the IPC socket path matches `NodeJSService.comapeoSocketPath`; `stateString(for:ipc:)` reflects the service state).
  - `ServiceLifecycleTest` — end-to-end tests of the shared `NodeJSService` driven by UIKit lifecycle events. Because `NodeMobileStartNode` can only be called once per process, these tests share a single service instance and are **ordered by alphabetical test name** (`test01_…` through `test99_…`) with the shutdown test forced to run last.

#### Testable seams

- `NodeJSService.init(filesDir:nodeEntryPoint:resolveJSEntryPoint:)` accepts closures for node-runtime startup and JS entry resolution so unit tests never call `NodeMobileStartNode`.
- `ComapeoCoreModule` exposes two internal statics (`resolveSocketPath()`, `stateString(for:ipc:)`) the example-app tests assert on.
- `NodeJSIPC.socket: Int32` is `internal` (not `private`) so `testLargeMessageIsDeliveredIntactUnderBackpressure` can set `SO_SNDBUF` / `O_NONBLOCK` to force partial writes.
- `waitForFile(atPath:timeoutSeconds:)` is file-scope `internal` so `WatchForFileTests` can call it directly.

#### Known-failing iOS tests (document real bugs)

The commit `c665cf6 Add failing tests for bugs surfaced by ultrareview` added tests that intentionally fail against the current implementation to lock in the bug and the desired behavior. They should stay red until the production code is fixed:

- `NodeJSIPCTests.testMessagesSentBeforeConnectAreBuffered` — pre-connect `sendMessage` calls are dropped at the "socket not connected" guard; must be buffered and flushed.
- `NodeJSIPCTests.testLargeMessageIsDeliveredIntactUnderBackpressure` — `sendMessageInternal` treats short `write()` returns as fatal, desyncing the receiver.
- `NodeJSServiceTests.testStopTimeoutTransitionsToErrorNotStopped` — a timed-out `stop()` currently lands in `.stopped`, which would permit a second `start()` and violate `NodeMobileStartNode`'s once-per-process constraint.
- `NodeJSServiceTests.testStartFromErrorStateIsRejected` — follow-up to the above.
- `ServiceLifecycleTest.test05_LateStateIPCReceivesStartedEvent` — Node-side `started`/`ready` messages are emitted before any iOS client finishes connecting, so `controlClients` is empty and the messages go nowhere.
- `ServiceLifecycleTest.test98_BackgroundDoesNotStopNode` — backgrounding triggers `stopWithBackgroundTask`, but since `NodeMobileStartNode` can't be restarted, the first background/foreground cycle permanently breaks the app.

## Development

```bash
npm run build        # Compile TypeScript
npm run clean        # Remove build artifacts
npm run lint         # Run ESLint
npm run test         # Run tests
npm run open:ios     # Open in Xcode
npm run open:android # Open in Android Studio
```

The `example/` directory contains an Expo app that benchmarks message throughput by sending 1000 randomized user objects and measuring round-trip time.

## Open TODOs

- Expose foreground service + Node.js process status to JS (`starting`, `running`, `stopping`, `stopped`)
- Serve blobs/icons over Unix domain socket, wrapped in a content provider
- Read `abiFilters` from consuming app's `build.gradle`
- Fix the iOS behavioral bugs currently documented by failing tests (pre-connect buffering, partial-write handling, stop-timeout state, late state-IPC delivery, background-handling once-per-process constraint)
- Implement web platform support
