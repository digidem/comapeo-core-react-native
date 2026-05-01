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

This module is the bridge that lets `comapeo-mobile` use `@comapeo/core` (a Node.js library) from within React Native. The embedded Node.js entry point is a rolled-up backend bundle (`backend/`, built via `scripts/build-backend.ts`) that initialises a `MapeoManager` and wraps it with `createMapeoServer` from `@comapeo/ipc`. The React Native side uses `createMapeoClient` over the `messagePort` exported by this module.

## Architecture overview

The module runs CoMapeo Core inside an embedded Node.js runtime and communicates with the React Native layer via length-prefixed JSON messages over Unix domain sockets. The process model differs per platform:

- **Android** uses a **dual-process** architecture: the UI runs in the main app process and Node.js runs in a separate `:ComapeoCore` foreground service process.
- **iOS** runs Node.js **in-process** on a dedicated thread (via `nodejs-mobile`'s `NodeMobileStartNode`). iOS has no foreground-service equivalent, and `NodeMobileStartNode` is **once-per-process** — so Node.js is started on first foreground, continues running across background/foreground transitions, and only stops on `applicationWillTerminate`.

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
│  - control.sock  (lifecycle/readiness)   │
└──────────────────────────────────────────┘
```

### IPC protocol

Messages are framed with a **4-byte little-endian length prefix** followed by a UTF-8 JSON payload. Both sides use this same protocol. On Android the Kotlin `NodeJSIPC` class implements the client side; on iOS the Swift `NodeJSIPC` class implements the same protocol. On the Node.js side, the `SocketMessagePort` class (wrapping `framed-stream`) implements the server side.

### Two socket channels

| Socket | Purpose |
|---|---|
| `comapeo.sock` | Main RPC channel for application data (maps to `messagePort` in JS) |
| `control.sock` | Control channel for lifecycle signals (`started`, `ready`, `shutdown`) |

## Directory structure

```
├── src/                          # TypeScript source (React Native side)
│   ├── index.ts                  # Public API exports
│   ├── ComapeoCoreModule.ts      # MessagePort + State wrappers around native module
│   └── ComapeoCore.types.ts      # Type definitions for events and payloads
│
├── backend/                       # Node.js backend, rolled up by build-backend.ts
│   ├── index.js                   # Entry — wires ComapeoRpcServer + control IPC
│   ├── lib/
│   │   ├── create-comapeo.js      # Constructs MapeoManager
│   │   ├── comapeo-rpc.js         # Main RPC server (wraps @comapeo/ipc)
│   │   ├── simple-rpc.js          # Control server: shutdown + readiness broadcasts
│   │   ├── server-helper.js       # net.createServer wrapper with graceful close
│   │   ├── message-port.js        # SocketMessagePort (framed JSON over sockets)
│   │   ├── maps-stub.js           # iOS-only no-op for @comapeo/core's maps fastify plugin
│   │   └── node-rs-crc32-shim.js  # Pure-JS shim for @node-rs/crc32 (can't be rolled up)
│   ├── rollup.config.js           # Two outputs: dist/android, dist/ios
│   ├── rollup-plugins/
│   │   └── rollup-plugin-addon-loader.js  # Rewrites bindings/node-gyp-build/require.addon → __loadAddon
│   └── patches/                   # patch-package patches applied at npm ci time
│
├── scripts/
│   └── build-backend.ts           # Rolls up backend, fetches per-addon prebuilds,
│                                  # emits jniLibs/<abi>/lib<name>__<version>.so (Android)
│                                  # and ios/Frameworks/<name>__<version>.xcframework (iOS).
│
├── android/
│   ├── src/main/java/com/comapeo/core/
│   │   ├── ComapeoCoreModule.kt                       # Expo module definition
│   │   ├── ComapeoCoreService.kt                      # Foreground service in :ComapeoCore process
│   │   ├── NodeJSService.kt                           # JNI wrapper for Node.js
│   │   ├── NodeJSIPC.kt                               # Unix socket IPC client
│   │   ├── ComapeoCoreReactActivityLifecycleListener.kt
│   │   ├── ComapeoCorePackage.kt
│   │   ├── Actions.kt
│   │   └── log.kt
│   ├── src/main/cpp/
│   │   ├── jni-bridge.cpp         # JNI bridge to libnode.so + stdout/stderr → logcat
│   │   └── log.cpp / log.h
│   ├── src/main/assets/nodejs-project/   # Generated; ESM bundle (index.mjs) + drizzle migrations + native pkg.json/binding.gyp
│   ├── src/main/jniLibs/<abi>/    # Generated; lib<name>__<version>.so per native addon × ABI
│   ├── src/main/AndroidManifest.xml      # extractNativeLibs="false" pairs with useLegacyPackaging=false
│   ├── libnode/                   # Vendored libnode.so per ABI (nodejs-mobile)
│   ├── build.gradle               # Android build config (Kotlin, CMake, NDK, jniLibs)
│   └── CMakeLists.txt             # C++ build config
│
├── ios/
│   ├── ComapeoCoreModule.swift              # Expo module definition
│   ├── AppLifecycleDelegate.swift           # ExpoAppDelegateSubscriber, owns shared NodeJSService
│   ├── NodeJSService.swift                  # Runs Node.js on a dedicated thread, manages lifecycle
│   ├── NodeJSIPC.swift                      # Unix socket IPC client + waitForFile helper
│   ├── NodeMobileBridge.{h,mm}              # Obj-C bridge to NodeMobile.xcframework
│   ├── Log.swift
│   ├── Package.swift                        # Swift Package for macOS-native tests
│   ├── ComapeoCore.podspec                  # vendored_frameworks: NodeMobile + Frameworks/*.xcframework
│   ├── nodejs-project/                      # Generated; ESM bundle + drizzle + native pkg.json (read-only inside .app bundle)
│   ├── Frameworks/                          # Generated; one <name>__<version>.xcframework per native addon
│   ├── NodeMobile.xcframework               # Vendored Node.js runtime
│   └── Tests/                               # Swift Package test target (see Testing)
│       ├── Helpers/
│       │   ├── MockNodeServer.swift
│       │   ├── MockNodeService.swift
│       │   ├── TestPaths.swift              # Short-path /tmp dir helper (sockaddr_un limit)
│       │   └── XCTestCase+Polling.swift     # waitUntil() helper — replaces Thread.sleep
│       ├── MessageFramingTests.swift
│       ├── WatchForFileTests.swift
│       ├── NodeJSIPCTests.swift
│       ├── NodeJSServiceTests.swift
│       └── IPCLifecycleTests.swift
│
├── example/                       # Example Expo app with benchmarks
│   ├── App.tsx                    # Sends 1000 messages, measures round-trip time
│   ├── tests/                     # Source-of-truth test files (copied into prebuilt projects)
│   │   ├── android/               #   ServiceLifecycleTest.kt, ShutdownPathTest.kt, WaitForFileTest.kt
│   │   └── ios/                   #   ComapeoCoreModuleTests.swift, ServiceLifecycleTest.swift, CoreManagerSmokeTest.swift
│   └── plugins/                   # Example-app-only Expo config plugins. NOT shipped to consumers of
│       │                          # @comapeo/core-react-native; they re-inject the example app's test target
│       │                          # every time `expo prebuild` regenerates example/ios|android/.
│       ├── with-ios-tests/        # Injects iOS test target at prebuild
│       │   ├── index.js           #   Copies ../../tests/ios/*.swift, idempotently patches Podfile via mergeContents
│       │   └── add-test-target.rb #   Adds the test target to the Xcode project
│       └── with-android-tests/    # Injects androidTest sources + deps via mergeContents
│
├── docs/                          # Architecture references and the canonical build plan
├── expo-module.config.json
├── package.json
└── tsconfig.json
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
- Copies the `nodejs-project` assets (the rolled-up `index.mjs` + drizzle migrations + native module `package.json`/`binding.gyp`) from the APK to `filesDir` on first launch / APK updates, gated on `lastUpdateTime`. Native `.so` files are not copied — they ship in `jniLibs/<abi>/` and Bionic mmaps them straight from the APK at `dlopen` time.
- Launches Node.js via JNI `startNodeWithArguments(["node", "index.mjs", comapeoSocketPath, controlSocketPath, dataDir])`.
- Sends `{"type":"shutdown"}` over `control.sock` for graceful shutdown.

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

### Node.js side (`backend/`)

The backend ships as a single rolled-up ESM bundle (`dist/<platform>/index.mjs`) produced by `backend/rollup.config.js` from `backend/index.js`. `scripts/build-backend.ts` runs `npm ci && npm run build` inside a temp copy of `backend/`, then stages the resulting bundle into `android/src/main/assets/nodejs-project/` and `ios/nodejs-project/` alongside the keep-listed non-JS files (drizzle migrations, native module `package.json`/`binding.gyp`, default-categories zip, fallback map).

**`backend/index.js`** — Entry point. Creates `ComapeoRpcServer` on `comapeo.sock` (main RPC, wraps `@comapeo/ipc`'s `createMapeoServer` around a `MapeoManager`) and `SimpleRpcServer` on `control.sock` (listens for `{"type":"shutdown"}`, broadcasts `{"type":"started"}` / `{"type":"ready"}` to control clients with replay on late connect).

**`backend/lib/create-comapeo.js`** — Constructs `MapeoManager` with `privateStorageDir` from argv: SQLite under `<dir>/sqlite-dbs/`, hypercore index under `<dir>/core-storage/`, custom maps under `<dir>/maps/`.

**`backend/lib/message-port.js`** — `SocketMessagePort` wraps a socket in `framed-stream` for length-prefixed JSON messaging. States: `idle → active → closed`.

**`backend/lib/maps-stub.js`** — iOS-only no-op for `@comapeo/core/src/fastify-plugins/maps.js`. Aliased in by the iOS rollup output because the real plugin imports `undici`, which calls `WebAssembly.compile` at module-init and crashes nodejs-mobile iOS (V8 runs `--jitless`). Tile fetching on iOS is broken until a non-WASM HTTP client is wired in (see issue #23).

**`backend/rollup-plugins/rollup-plugin-addon-loader.js`** — Replaces every native-loader pattern (`require('bindings')(...)`, `require('node-gyp-build')(__dirname)`, `require.addon('.', __filename)`) with a call to a single injected `__loadAddon(name, version)` helper. The helper lives in each output's `output.banner` and dispatches per platform: Android does `process.dlopen(mod, 'lib<name>__<version>.so')` (bare filename — Bionic resolves it against the APK's mmap region); iOS does `process.dlopen(mod, NATIVE_LIB_DIR + '/' + key + '.framework/' + key)` against the Embed-&-Sign'd xcframework binary. Version-aware so multi-version dep graphs (e.g. `sodium-native@4.3.3` + `@5.1.0`) get the correct `.so`/framework per importer.

### Native packaging

`scripts/build-backend.ts` enumerates every `(name, version)` instance of the seven native modules from the backend's `node_modules` (top-level + nested) and emits per-platform artifacts:

- **Android**: `android/src/main/jniLibs/<abi>/lib<name>__<version>.so` per ABI (`armeabi-v7a`, `arm64-v8a`, `x86_64`). The APK ships them uncompressed and aligned (`packagingOptions.jniLibs.useLegacyPackaging = false` in `android/build.gradle`, `android:extractNativeLibs="false"` in the manifest); Bionic mmaps them straight from the APK at `dlopen` time. **Bare-name `dlopen` only** — a full-path `dlopen` would fail because `nativeLibraryDir` contains nothing under this configuration.
- **iOS**: `ios/Frameworks/<name>__<version>.xcframework` per native module, each containing a device slice (`ios-arm64`) and a fat simulator slice (`arm64+x86_64`). `ios/ComapeoCore.podspec` declares them via `s.vendored_frameworks` (glob). Xcode's standard Embed & Sign phase places `<name>__<version>.framework/` under `<App>.app/Frameworks/` at app build time and codesigns each. Swift exports `NATIVE_LIB_DIR=<bundlePath>/Frameworks` before `NodeMobileStartNode` so the JS-side `__loadAddon` helper resolves the right path.

Per-addon prebuilds are downloaded by `build-backend.ts` from `digidem/<name>-nodejs-mobile` GitHub Releases (versions resolved from the backend's lockfile, not a hand-maintained list). The xcframework wrap step requires macOS Xcode tooling (`xcodebuild`, `lipo`, `install_name_tool`) and is skipped on Linux CI runners (Android workflow).

### iOS native layer

#### ComapeoCoreModule (`ComapeoCoreModule.swift`)
The Expo module entry point. On `OnCreate` it creates a `NodeJSIPC` pointed at the shared `NodeJSService`'s `comapeo.sock` and forwards `"message"` events to JavaScript. `Function("postMessage")` forwards calls to the IPC; `Function("getState")` reflects the service state; `"stateChange"` events are emitted from the shared `NodeJSService.onStateChange` callback.

#### AppLifecycleDelegate (`AppLifecycleDelegate.swift`)
An `ExpoAppDelegateSubscriber` that owns a **single static** `NodeJSService` exposed as `AppLifecycleDelegate.nodeService`. `NodeMobileStartNode` can only be called once per process, so the service must be a process-wide singleton — Expo's autolinking instantiates its own delegate, every callsite that needs the service goes through the static, and a `#if DEBUG`-only `static let shared` exists for test code that needs to drive the lifecycle methods directly (e.g. invoking `applicationDidEnterBackground` from a regression test). The static is the API; the instance is incidental.

Production callsites must access `AppLifecycleDelegate.nodeService` (the static), never `.shared.nodeService`. Lazy-initialising `.shared` from a non-main thread traps under Xcode 26 / Swift 6: the inherited `BaseExpoAppDelegateSubscriber.init()` derives from `UIResponder`, which is `@MainActor`-isolated, and Swift's runtime executor check (`_swift_task_checkIsolatedSwift`) SIGTRAPs when init runs off-main — exactly what `ComapeoCoreModule.OnCreate` does, since Expo runs it on the React Native JS thread. `.shared` stays gated to DEBUG so the surface area can't accidentally be reached from a release build.

Lifecycle hooks:
- `applicationDidBecomeActive` — `Self.nodeService.start()` (guarded by `state == .stopped`, so subsequent foregrounds are no-ops).
- `applicationDidEnterBackground` — deliberately a **no-op**. Stopping on background would permanently break the app because we can't restart the Node.js runtime in the same process. iOS may suspend or terminate the app during long background windows, at which point the next launch is a fresh process.
- `applicationWillTerminate` — synchronous `Self.nodeService.stop(timeout: 5)` as a final graceful-shutdown hook.

#### NodeJSService (`NodeJSService.swift`)
Runs Node.js on a dedicated 2 MB-stack thread (required by nodejs-mobile). Responsibilities:
- Allocates `comapeo.sock` and `control.sock` under `socketDir` — `/tmp/comapeo-<pid>` on simulator (the host Mac's `/tmp`, namespaced by PID), or `NSTemporaryDirectory()` on device. The path budget is constrained by `sockaddr_un.sun_path`'s 104-byte limit; `init` enforces this loudly. See `AppLifecycleDelegate.resolveSocketDir()`.
- Opens a `NodeJSIPC` against `control.sock` for lifecycle/control messages.
- Calls the `NodeEntryPoint` closure (blocking call into `NodeMobileStartNode`) on the node thread.
- On `stop()`, sends `{"type":"shutdown"}` over `control.sock` and waits on a completion semaphore signalled by the node thread's exit.
- On `stop()` **timeout**, transitions to `.error` rather than `.stopped`, because the node thread is still alive and calling `start()` again would violate the once-per-process constraint. `cleanup(threadExited:)` takes the flag.

State machine: `STOPPED → STARTING → STARTED → STOPPING → STOPPED`, with an additional `ERROR` terminal state reached only on timed-out shutdowns.

`NodeEntryPoint` and `resolveJSEntryPoint` are injected so tests can substitute a blocking-semaphore fake for the real `NodeMobileStartNode` call.

The file has no UIKit imports — it's compiled into the `ComapeoCore` Swift Package target so the macOS-native test suite can exercise it without a simulator.

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

### iOS asset layout

`ios/nodejs-project/` is generated by `build-backend.ts` and bundled into `<App>.app/nodejs-project/` as a read-only resource. iOS does not extract it on cold start — `resolveJSEntryPoint` hands `NodeMobileStartNode` the path inside the `.app` bundle directly. SQLite/blobs/indexes/custom maps that need write access go to `privateStorageDir` (Application Support) instead.

Android extracts `nodejs-project/` from the APK to `filesDir` on cold install / app upgrade because the APK doesn't expose a filesystem-readable path to its assets the way `<App>.app/<name>/` does on iOS.

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
| iOS | Functional | In-process Node.js via `nodejs-mobile`, IPC, graceful shutdown |
| Web | Not started | Declared in expo-module.config.json but no implementation |

## Testing

### Android

| Layer | Tool | Location |
|---|---|---|
| JVM unit tests | JUnit4 | `android/src/test/java/com/comapeo/core/` |
| Instrumented IPC/file-watch tests | AndroidJUnit4 | `android/src/androidTest/java/com/comapeo/core/` |
| Service lifecycle integration tests | AndroidJUnit4 on example app | `example/tests/android/` (injected into the prebuilt `example/android/` by the `with-android-tests` config plugin) |
| Local runner | Shell script | `e2e/run-instrumented-tests.sh` |
| CI | `.github/workflows/android-tests.yml` | |

Both example apps (`example/android/` and `example/ios/`) are now gitignored — they're regenerated by `npx expo prebuild` and their test targets are reinjected by the `with-android-tests` / `with-ios-tests` config plugins each time. The source of truth for platform-integration test code lives under `example/tests/android/` (Kotlin) and `example/tests/ios/` (Swift).

### iOS

Two test layers, two CI jobs:

| Layer | Tool | Location | How it's run |
|---|---|---|---|
| Swift Package tests (mocked Node.js) | `swift test` on macOS | `ios/Tests/` | `package-tests` CI job — runs on macOS, no simulator |
| Example app tests (real Node.js) | `xcodebuild test` on the example workspace | `example/tests/ios/` | `integration-tests` CI job — iOS Simulator, requires `NodeMobile.xcframework` |
| CI workflow | `.github/workflows/ios-tests.yml` | | |

The example-app test target isn't checked into `example/ios/` — it's injected at Expo prebuild time by the `with-ios-tests` config plugin (`example/plugins/with-ios-tests/`), which copies the Swift sources from `example/tests/ios/` into the prebuilt Xcode project, idempotently injects a CocoaPods test target into the `Podfile` via `mergeContents` (`# @generated begin/end with-ios-tests:test-target`), and registers the test target in the Xcode project via a Ruby script using the `xcodeproj` gem. This keeps the test sources under version control without committing the generated Xcode project.

**Important:** this plugin is internal to the example app — it is not part of the public surface of `@comapeo/core-react-native`. Module consumers do not import or register it; they configure their own test setup as they see fit. The Podfile mutation goes against Expo's general guidance ("don't modify the Podfile from a config plugin") because there's no first-class Expo mod for adding CocoaPods test targets — see the discussion in PR #6 review for the full reasoning.

#### Swift Package tests (`ios/Tests/`)

The `ComapeoCore` Swift Package target (`ios/Package.swift`) compiles only the UIKit-free files (`NodeJSIPC`, `NodeJSService`, `Log`), so the whole test suite runs on macOS via `swift test` — no simulator, no code signing, no NodeMobile. The full run is a few seconds.

- `WatchForFileTests` — tests the `waitForFile` helper directly.
- `NodeJSIPCTests` — connects `NodeJSIPC` to a real Unix domain socket via `MockNodeServer`. Covers framing, pre-connect buffering, partial-write handling, error-state recovery, and concurrent shutdown.
- `NodeJSServiceTests` — drives `NodeJSService` with a mock `NodeEntryPoint` that blocks on a `DispatchSemaphore` until signalled, simulating the node runtime without calling `NodeMobileStartNode`.
- `IPCLifecycleTests` — wires `NodeJSService` + `NodeJSIPC` + `MockNodeServer` for end-to-end mocked lifecycle scenarios.

Shared helpers live in `ios/Tests/Helpers/`:

- `MockNodeServer.swift` — Unix-socket mock server used by all three integration-style test files.
- `MockNodeService.swift` — `makeMockNodeService(filesDir:)` factory returning `(NodeJSService, signalExit)`. Used by `NodeJSServiceTests` and `IPCLifecycleTests` to avoid duplicating the blocking-semaphore node entry point.
- `TestPaths.swift` — `makeShortTempDir(prefix:)` centralises the `/tmp`-based short-path workaround for `sockaddr_un.sun_path`'s 104-byte limit, with the reasoning documented in one place.
- `XCTestCase+Polling.swift` — `waitUntil(_ message:, _ condition:)` replaces `Thread.sleep` + `XCTAssert` in async-state-change tests. Sleeps are fragile under CI load; polling returns as soon as the condition flips and fails fast with a clear message when it doesn't.

#### Example app tests (`example/tests/ios/`)

These run against the **real** `NodeMobileStartNode` inside the example app target, so they're the only layer that exercises the actual Node.js runtime + JS entry point.

- `ComapeoCoreModuleTests` — verifies two testable seams on `ComapeoCoreModule` (the IPC socket path matches `NodeJSService.comapeoSocketPath`; `stateString(for:ipc:)` reflects the service state).
- `ServiceLifecycleTest` — a single `testFullServiceLifecycle` method that walks startup, steady-state assertions, background behaviour, and graceful shutdown as sequential phases wrapped in `XCTContext.runActivity(named:)` blocks. The phases can't run in isolation because `NodeMobileStartNode` is once-per-process; a monolithic method makes that constraint part of the code rather than a naming convention.
- `CoreManagerSmokeTest` — boots the real backend, opens an IPC connection to `comapeo.sock`, and asserts `listProjects()` round-trips. Forces the JS side to construct `ComapeoManager` (drizzle migrations + `sodium-native` dlopen + `better-sqlite3` open + `@comapeo/core` constructor).

#### Testable seams in production code

- `NodeJSService.init(socketDir:privateStorageDir:nodeEntryPoint:resolveJSEntryPoint:)` accepts closures for node-runtime startup and JS entry resolution so unit tests never call `NodeMobileStartNode`.
- `NodeJSService.cleanup(threadExited:)` lets callers signal whether the node thread actually exited — controls the `.stopped` vs `.error` transition.
- `ComapeoCoreModule` exposes two internal statics (`resolveSocketPath()`, `stateString(for:ipc:)`) the example-app tests assert on.
- `NodeJSIPC.socket: Int32` is `internal` (not `private`) so `testLargeMessageIsDeliveredIntactUnderBackpressure` can set `SO_SNDBUF` / `O_NONBLOCK` to force partial writes.
- `waitForFile(atPath:timeoutSeconds:)` is file-scope `internal` so `WatchForFileTests` can call it directly.

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

## Open follow-ups

Tracked as GitHub issues. Highlights:

- Phase 3 — integrated assembled-backend smoke test (#25)
- Phase 4 — `socket-transport.js` extraction for runtime-swap prep (#26)
- Android JNI stdio drain race (#19)
- iOS real-device runtime smoke test (#20) and TestFlight ritual (#21)
- iOS `globalThis.fetch` polyfill (#22) and maps plugin re-introduction (#23, #24)
- IPC backpressure / flow control (#27)
- Android lifecycle-state parity with iOS + TS bindings (#29)
- `abiFilters` from consuming app (#30); blobs/icons over UDS (#31); web platform (#32)
- Rootkey storage migration from `expo-secure-store` (see `docs/root-key-storage-and-migration-plan.md`)
