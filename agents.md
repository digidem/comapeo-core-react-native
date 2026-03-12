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

The module uses a **dual-process architecture**: the React Native UI runs in the main app process, while CoMapeo Core runs inside an embedded Node.js runtime in a separate process (Android foreground service). The two communicate via length-prefixed JSON messages over Unix domain sockets.

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

Messages are framed with a **4-byte little-endian length prefix** followed by a UTF-8 JSON payload. Both sides use this same protocol. On Android, the Kotlin `NodeJSIPC` class implements the client side; on the Node.js side, the `SocketMessagePort` class (wrapping `framed-stream`) implements the server side.

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
│   ├── ComapeoCoreModule.swift    # Expo module (stub/placeholder)
│   ├── ComapeoCoreView.swift      # WKWebView native component
│   └── ComapeoCore.podspec        # CocoaPods spec
│
├── example/                       # Example Expo app with benchmarks
│   └── App.tsx                    # Sends 1000 messages, measures round-trip time
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

### iOS

The iOS implementation is currently a **stub/placeholder**. It contains a WKWebView-based component but does not implement the full IPC messaging that Android provides.

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
| iOS | Stub | WebView placeholder, IPC not implemented |
| Web | Not started | Declared in expo-module.config.json but no implementation |

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
- Implement iOS native module with full IPC support
- Implement web platform support
