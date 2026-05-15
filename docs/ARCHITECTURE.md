# Architecture

How the embedded backend is structured, how the React Native layer talks
to it, and the alternatives we considered along the way. Companion docs:

- [`ForegroundService.md`](./ForegroundService.md) — Android FGS specifics
  (timeout policy, user-stop handling, `dataSync` service type).
- [`root-key-storage-and-migration-plan.md`](./root-key-storage-and-migration-plan.md)
  — design rationale for the Kotlin/Swift-native rootkey stores.
- [`bare-architecture.md`](./bare-architecture.md),
  [`runtime-alternatives.md`](./runtime-alternatives.md) — why we are on
  `nodejs-mobile` and what we'd migrate to instead.

---

## 1. TL;DR

- iOS runs everything in one process. Android runs the embedded Node.js
  in a separate `:ComapeoCore` process behind a foreground service so it
  survives backgrounding.
- The React Native layer talks to Node over **two Unix-domain sockets**:
  `comapeo.sock` (RPC) and `control.sock` (lifecycle + handshake).
- Boot is gated on a rootkey handshake on the control socket: backend
  binds → broadcasts `started` → native sends the rootkey in an `init`
  frame → backend constructs `MapeoManager` → broadcasts `ready`.
- The JS layer observes a single `ComapeoState`
  (`STOPPED`/`STARTING`/`STARTED`/`STOPPING`/`ERROR`) plus structured
  `getLastError()` detail. The native ↔ JS plumbing differs by platform
  (in-process callback on iOS; second control-socket connection on
  Android) but the JS surface is identical.
- We deliberately did not adopt `expo-secure-store` for rootkey storage,
  did not use Android Intent broadcasts / `Messenger` / a bound service
  for FGS↔main state notification, and did not collapse the boot sequence
  into a single broadcast. Rationales below.
- Optional **Sentry observability** is wired up via an Expo config
  plugin (`app.plugin.js`) and the `@comapeo/core-react-native/sentry`
  sub-export. The FGS process gets its own Sentry SDK init via a
  guarded bridge (zero runtime cost when the consumer doesn't use
  Sentry). See §7.

---

## 2. Process model

### 2.1 iOS — in-process

The Node.js runtime runs on a background `Thread` inside the host app
process, started by `NodeJSService.runNode()` (`ios/NodeJSService.swift`).
The thread is owned by `AppLifecycleDelegate.nodeService`, an
`ExpoAppDelegateSubscriber` singleton constructed during
`application(_:didFinishLaunchingWithOptions:)`.

There is no second process. The control socket and the comapeo socket
are AF_UNIX sockets in the host app's `Application Support` directory;
both ends of every socket-related interaction live inside the same
`.app` bundle.

### 2.2 Android — `:ComapeoCore` separate process

The FGS is declared with `android:process=":ComapeoCore"` in
`android/src/main/AndroidManifest.xml`. The `:`-prefix is Android's
syntax for a private process; the FGS gets its own zygote-forked pid,
its own `Application` instance, its own `nodejs-mobile` JNI loader, and
its own AndroidKeyStore client. The main React Native UI process
(`com.comapeo.core.example` in the example app) is separate.

**Why a separate process?** Three reasons:

1. **Survival across UI restarts.** React Native reloads, hot-restarts,
   and developer-menu actions kill the main process or its JS bridge.
   The FGS process keeps running, so a debug rebuild doesn't tear down
   the embedded sync state.
2. **Memory isolation.** `nodejs-mobile` carries its own V8 heap plus
   `better-sqlite3` mmap regions plus `sodium-native` buffers. Keeping
   that out of the RN process means the OS can kill RN under memory
   pressure without taking the backend with it (and vice versa).
3. **Foreground service grammar.** The `dataSync` FGS type
   (see [ForegroundService.md](./ForegroundService.md)) requires a
   long-lived service component; running it in the UI process would
   mean any RN-process death stops the sync notification too.

The cost is cross-process IPC: the UI process has to talk to the FGS
process via the OS, not via shared memory. The two Unix-domain sockets
described in §3 are how.

### 2.3 Code locations

| Concern | iOS | Android |
|---|---|---|
| Service lifecycle | `ios/NodeJSService.swift` | `android/src/main/java/com/comapeo/core/NodeJSService.kt` (FGS-side) |
| Service container | n/a | `ComapeoCoreService.kt` (FGS) |
| Expo module / RN bridge | `ios/ComapeoCoreModule.swift` | `android/src/main/java/com/comapeo/core/ComapeoCoreModule.kt` |
| App-level wiring | `ios/AppLifecycleDelegate.swift` | example-app's `MainApplication.kt` |
| Rootkey store | `ios/RootKeyStore.swift` | `RootKeyStore.kt` |
| Backend (Node-side) | `backend/index.js` (shared) | `backend/index.js` (shared) |
| RN-side observers | `src/ComapeoCoreModule.ts` (shared) | `src/ComapeoCoreModule.ts` (shared) |

---

## 3. IPC channels

### 3.1 The two sockets

Both sockets are AF_UNIX, length-prefixed JSON framing, bound by Node.js
inside the backend process. Native code connects as a client. The
control socket is also a write channel from native to Node for the
init / shutdown / error-native frames listed in the table in §3.1.

#### `comapeo.sock` — application RPC

Carries `@comapeo/ipc` request/response traffic. Bound by Node.js
(`ComapeoRpcServer.listen(comapeoSocketPath)`) only AFTER `MapeoManager`
has been constructed. The main app process connects and uses
`createMapeoClient(messagePort)` to expose a typed RPC client to JS
(`src/ComapeoCoreModule.ts`'s `comapeo` export).

A late connection (i.e. the React Native module connects after Node has
already bound this socket) is the steady state: the backend always binds
this socket some hundreds of milliseconds after process start. The
`NodeJSIPC.connectWithRetry()` 50 ms-cadence retry loop handles the gap.

#### `control.sock` — lifecycle + handshake

Carries small JSON frames that drive the boot handshake and surface
error/lifecycle transitions. Bound by Node.js
(`SimpleRpcServer.listen(controlSocketPath)`) BEFORE the comapeo socket,
because the backend uses this channel to receive the rootkey from native
before it can construct `MapeoManager`. Frames in current use:

| Direction | Frame | When |
|---|---|---|
| Node → native | `{type:"started"}` | Control socket bound, backend awaiting init. |
| Native → Node | `{type:"init",rootKey:"<base64>"}` | Native ships the rootkey from `RootKeyStore` (single-shot). |
| Node → native | `{type:"ready"}` | `MapeoManager` constructed, comapeo socket bound. |
| Node → native | `{type:"stopping"}` | Backend has begun graceful shutdown (sent before any close work). |
| Node → native | `{type:"error",phase,message,stack?}` | Boot failure or uncaught throw at any phase. |
| Native → Node | `{type:"shutdown"}` | Native requests graceful shutdown. |
| Native → Node | `{type:"error-native",phase,message}` | FGS-side local failure (rootkey, watchdog) — backend re-broadcasts as an `error` frame and exits. |

**Replay semantics.** `SimpleRpcServer` (`backend/lib/simple-rpc.js`)
remembers its last readiness phase and replays `started` and `ready` to
any client that connects after they were broadcast. Without replay a
late-connecting client (the React Native module on Android races the
FGS's IPC client; both connect to the same socket, see §4) would miss
the events that already fired.

Terminal lifecycle frames — `stopping` and `error`, both sent via
`broadcast()` — are **also** cached and replayed, but only the latest
one. The window between either frame and the natural socket close is
non-zero (~100 ms for `error` before `process.exit(1)`; the duration
of `Promise.all([close…])` for `stopping`), and a client that connects
in that window would otherwise have to infer the terminal state from
the disconnect alone. That inference is lossy in two ways: a graceful
`stopping`-then-close looks identical to an unexpected crash to a
client that missed the frame (STARTING/STARTED → ERROR per §5.4), and
an `error` frame's phase and message are replaced by a synthetic
`node-runtime-unexpected`. Caching the latest terminal frame closes
both gaps with a single object reference of overhead.

### 3.2 Why two sockets

Three signals matter:

1. The application RPC needs ordered request/response framing with no
   interleaved lifecycle noise. Mixing `{type:"ready"}` into the same
   stream as `MapeoManager.something()` calls would force every RPC
   client to filter unwanted frames.
2. The control socket has different bind timing from the RPC socket: it
   binds first (so native can hand over the rootkey before the manager
   is constructed). Folding them would push the manager construction
   into the bind path or push the rootkey handshake into the RPC path,
   both worse.
3. The control socket's **multi-client + replay** semantics
   (§3.1) only make sense for lifecycle frames. The RPC socket is a
   classic 1:1 channel.

Splitting cost: ~80 LOC in `simple-rpc.js` for the second server class
and one extra `NodeJSIPC` instance on each platform.

### 3.3 Framing protocol

Both sockets use the same wire format: 4-byte little-endian length
prefix, then UTF-8 JSON payload. Implementations:
- iOS: `ios/NodeJSIPC.swift::receiveMessage`,
  `writeFully` for the matching writer.
- Android: `android/src/main/java/com/comapeo/core/NodeJSIPC.kt::receiveMessage`.
- Node: `backend/lib/message-port.js`.

There is no message-id or correlation field at this layer; that lives
inside `@comapeo/ipc` for RPC traffic, and isn't needed for control
frames (each `type` is its own protocol).

---

## 4. Boot sequence

### 4.1 The handshake

```
                Node.js backend                     Native (FGS or iOS)
                ┌─────────────┐                     ┌──────────────────┐
                │             │                     │                  │
   bind         │             │                     │                  │
   control.sock │             │                     │                  │
   ─────────────┤             │                     │                  │
                │             │                     │                  │
                │             │                     │  connect via     │
                │             │ ◄─────────────────  │  NodeJSIPC       │
                │             │                     │  (50 ms retry    │
                │             │                     │   loop)          │
                │             │                     │                  │
                │             │                     │                  │
   broadcast    │             │ ──{started}──►      │                  │
   started      │             │                     │                  │
                │             │                     │                  │
                │             │                     │  loadOrInitialize│
                │             │                     │  (RootKeyStore)  │
                │             │                     │                  │
                │             │ ◄──{init,rootKey}── │                  │
   construct    │             │                     │                  │
   MapeoManager │             │                     │                  │
   bind         │             │                     │                  │
   comapeo.sock │             │                     │                  │
                │             │                     │                  │
   broadcast    │             │ ──{ready}─────────► │  transition      │
   ready        │             │                     │  to STARTED      │
                │             │                     │                  │
                │             │                     │  RN module       │
                │             │                     │  connects to     │
                │             │                     │  comapeo.sock    │
```

Pre-rootkey: the backend cannot construct `MapeoManager` (the rootkey is
a constructor argument). Pre-`ready`: the native side cannot guarantee
RPC will succeed. The handshake exists to make both invariants
observable rather than racy.

### 4.2 Why the rootkey crosses the socket boundary

Native owns the rootkey because it has to: the FGS on Android starts
Node BEFORE React Native is alive (the FGS may be cold-launched by the
system to deliver a sync trigger), so we cannot block on a JS round-trip
to fetch the key. Native loads it synchronously from the platform store
and ships it on the control socket as the first thing the backend hears.

iOS doesn't have the FGS-cold-launch problem (see §2.1) but uses the
same handshake for symmetry — the alternative would be a per-platform
boot path with an extra Swift codepath that constructs the manager
in-process. Not worth the divergence.

### 4.3 Late-join (Android only)

On Android the React Native module ALSO connects to `control.sock` (as a
read-only observer; only the FGS-side `NodeJSService.kt` sends `init`
and `shutdown` frames). This second connection is the channel by which
state transitions reach the JS layer in the main app process — see §5.

The replay semantics in `SimpleRpcServer.setReadinessPhase` are what
makes this late connection work: by the time the RN module's
`ComapeoCoreModule` is loaded, the backend has often already broadcast
both `started` and `ready`. Without replay, the module would receive
nothing and would be stuck at `STOPPED` until the next transition.

### 4.4 Why a second control-socket connection (Android)?

The main app process needs lifecycle visibility into a state machine
that physically lives in another process. Alternatives are surveyed in
§7.1; the short version is that reusing the `NodeJSIPC` client class
(which already exists for `comapeo.sock`) avoids ~100 LOC of new Android
service plumbing and keeps Node as the single source of truth for
lifecycle state — matching iOS where the equivalent is in-process and
trivial.

---

## 5. Lifecycle state machine

### 5.1 Per-component states + derivation

`NodeJSService.State` (both platforms) is a *derived* value with five
possibilities — `STOPPED`, `STARTING`, `STARTED`, `STOPPING`, `ERROR`
— computed by a pure function of three independently-stateful
components:

```
NodeRuntime    ∈ { NotRunning, Running, Exited(code, reason) }
                 reason ∈ { Requested, Unexpected }

BackendState   ∈ { Unknown, ControlBound, Ready, Stopping,
                   Error{phase, message} }
                 (sourced from control-socket frames)

stopRequested  ∈ { false, true }
                 (set by stop(); cleared on next start())
```

`deriveState(nodeRuntime, backendState, stopRequested)` is a small
decision tree (top to bottom — earlier matches win):

1. Backend reported error → `ERROR`.
2. Runtime exited unexpectedly → `ERROR`.
3. `stopRequested` is true → `STOPPED` if runtime is gone, else `STOPPING`.
4. Backend announced stopping → `STOPPING`.
5. Backend reached ready → `STARTED`.
6. Runtime is running OR backend reached controlBound → `STARTING`.
7. Otherwise → `STOPPED`.

The model addresses three previously-broken paths:

- **Node exits cleanly without an error frame** → `nodeRuntime`
  becomes `Exited(_, Unexpected)` and the derivation produces `ERROR`
  deterministically. Without per-component state, this used to land
  in `STOPPED` (Android) or hang (iOS).
- **Node crashes (non-zero exit) without an error frame** → same
  path, same outcome.
- **FGS-side local failure (rootkey, watchdog) before Node can
  broadcast** → see §5.5 (Native→Node error forwarding). The FGS
  ships an `error-native` frame to Node, the backend re-broadcasts
  it as an `error` frame, and the main-app process gets a real
  `error` frame with the actual phase rather than a generic disconnect.

### 5.2 What feeds each component

- `NodeRuntime` is set by `start()` (→ `Running`), the runtime exit
  point in `runNode()` (→ `Exited(code, reason)`), and `cleanup()`
  / `destroy()` (→ `Exited(0, Requested)` to force a clean STOPPED).
  The exit reason is classified at exit time: `Requested` if
  `stopRequested` was true OR `backendState` was `Stopping` or
  `Error` (an in-flight graceful shutdown OR a backend error already
  acknowledged). Anything else → `Unexpected`.

- `BackendState` is set by `handleControlMessage` from the four
  well-known frames (`started` → `ControlBound`, `ready` → `Ready`,
  `stopping` → `Stopping`, `error` → `Error{phase,message}`) and
  by local failure paths that share the same conceptual slot
  (rootkey load failure, startup watchdog timeout, missing JS file
  → `Error{phase,message}`).

- `stopRequested` is set by `stop()` synchronously, before any I/O.

`ERROR` is **observable but does not tear down the node thread**.
Recovery is the application's responsibility (restart the FGS on
Android, re-create the service on iOS, prompt the user, log a report).
`ERROR` remains **per-instance terminal**: `start()` and `stop()`
are refused; only `destroy()` (Android) or `cleanup()` (iOS) clears
the slate, and after that a fresh `NodeJSService` instance is
required.

### 5.3 JS-visible state

`ComapeoState` (`src/ComapeoCore.types.ts`) is the same union, exposed
to React Native as `state.getState()` and the `stateChange` event. The
event payload carries optional `errorPhase` / `errorMessage` when the
state is `ERROR`; `state.getLastError()` returns the structured detail.

**`lastError` persistence is intentionally asymmetric.** A fresh
`start()` clears it (a new lifecycle starts with a clean slate);
`cleanup()` / `destroy()` preserves it (so a caller that observed
ERROR can still read `getLastError()` after cleanup to decide what
to do next — log, prompt, recreate the service, etc.). In normal
flows JS only reads `lastError` inside the `stateChange` callback
where state is `ERROR`, so the asymmetry isn't observable; callers
that poll `getLastError()` standalone after `cleanup()` see the
last-cycle error until the next `start()` clears it.

### 5.4 Native ↔ JS plumbing

**iOS** (`ios/ComapeoCoreModule.swift`): in-process callback —
`AppLifecycleDelegate.nodeService.onStateChange = { state in
sendEvent("stateChange", payload) }`. Payload includes
`state.getLastError()` when the state is `.error`.

**Android** (`ComapeoCoreModule.kt`, main app process): the main app
process is a separate process from the FGS, so it cannot read FGS-side
component state directly. Instead it derives JS-visible state from a
second `NodeJSIPC` connection to the control socket, combining:

- Control-socket frames (`started`, `ready`, `stopping`, `error`).
- The IPC's own connection state (`Connecting`, `Connected`,
  `Disconnecting`, `Disconnected`, `Error{cause}`).

The disconnect-reason logic mirrors the FGS-side derivation:

| Pre-disconnect JS state | Outcome |
|---|---|
| `ERROR` | stay (terminal) |
| `STOPPING` or `STOPPED` | → `STOPPED` (graceful) |
| `STARTING` or `STARTED` | → `ERROR` with phase `node-runtime-unexpected` |

A `stopping` frame from the backend (sent by §5.5) drives the JS state
to `STOPPING` *before* the socket close, so a graceful shutdown lands
in `STOPPED`. An unannounced disconnect from a running state lands in
`ERROR` — that's the cross-process equivalent of the FGS-side
`NodeRuntime.Exited(_, Unexpected)` rule.

### 5.5 Errors

Three failure surfaces, all converging on `ERROR`:

1. **Native-local failures** (both platforms, originating in the
   `NodeJSService` host — the FGS process on Android, the iOS app
   process on iOS): rootkey load, JS entry point not found, shutdown
   timeout, watchdog timeout, unexpected node exit. Tagged with
   phases like `rootkey`, `node-runtime`, `shutdown-timeout`,
   `starting-timeout`, `node-runtime-unexpected`. These set
   `BackendState.Error{phase, message}` (or `NodeRuntime.Exited(_,
   Unexpected)`) directly on the local `NodeJSService`, which derives
   to `ERROR` and populates `_lastError`. They never go through
   Node's `handleFatal` — the failure originated native-side and the
   native side reports it native-side.

   **Cross-process attribution** matters only on Android, where the
   main-app process is separate from the FGS and observes lifecycle
   only through the control socket. When the FGS-side failure is
   local (rootkey, watchdog) but Node is still alive, the FGS
   additionally ships an `error-native` frame to Node: the backend's
   `error-native` handler routes to `handleFatal`, which broadcasts
   an `error` frame to all control clients (including the main-app
   process's read-only observer) and exits 1 after a 100ms flush.
   Without this, an FGS rootkey failure would leave Node hanging on
   `await initPromise` indefinitely — the FGS knows it has failed
   but has no way to tell the main-app process. iOS has no
   `error-native` channel because the JS module reads
   `service.state` directly via the in-process `onStateChange`
   callback; there is no second process to attribute to.

2. **Backend-reported failures** (Node-side throws, both platforms):
   `process.on("uncaughtException")` and
   `process.on("unhandledRejection")` route through
   `handleFatal(phase, error)` which calls
   `controlIpcServer.broadcast({type:"error", phase, message, stack})`
   and exits 1 after a 100ms flush wait. Boot-phase errors (`init`,
   `listen-control`, `construct`, `runtime`) follow the same path
   via the boot IIFE's catch. The `error-native` handler from §1 is
   what bridges Android FGS-local failures *into* this same path,
   so all `error` frames seen on the wire come from `handleFatal`.

3. **IPC-level failures** (Android main-app side): `NodeJSIPC.State.Error`
   maps to `ERROR` with phase `ipc`. Phase distinguishes "connection
   layer broke" from "backend reported an error".

### 5.6 Protocol errors — separate channel

Frames the native control-socket parser cannot process (non-JSON,
missing `type`, or an unknown `type`) are **not** raised to `ERROR`.
They fire a `messageerror` event on the JS `state` observer instead,
mirroring the DOM `MessagePort` counterpart. Rationale: the lifecycle
should reflect what the service is doing (running, ready, errored),
not whether one frame was malformed. A single bad frame should be
discoverable for debugging without taking down a working session;
subsequent valid frames keep driving `stateChange` normally.

The event payload is `{ data: string }` on the wire; the JS observer
wraps it in `new Error(data)` for ergonomics. Listeners:

```ts
state.addListener("messageerror", (error: Error) => {
  console.warn("control-socket protocol error:", error.message);
});
```

Native plumbing:
- **Android**: `ComapeoCoreModule.kt` calls `sendEvent("messageerror",
  ...)` directly from its control-socket `onMessage` handler.
- **iOS**: `NodeJSService.swift` exposes an `onMessageError` callback;
  `ComapeoCoreModule.swift` wires it to `sendEvent("messageerror",
  ...)`.
- **Android FGS-side**: `NodeJSService.kt` logs the bad frame; it has
  no JS bridge, so there is nowhere to forward to. The main-app
  process's `controlIpc` receives the same broadcast and emits the
  event there.

### 5.7 Timeout topology

Every wait in the lifecycle path has either a local timeout or a
caller-side bound. Catalogued here so the next person debugging a
"why did this hang for N seconds" question doesn't have to grep three
codebases.

**Native side:**

| # | Where | Default | Guards against | On expiry |
|---|-------|---------|---------------|-----------|
| 1 | iOS `startupTimeout` (`NodeJSService.swift`) | 30 s | Service stuck in `STARTING` (Node parked, no `ready` frame) | Sets `backendState = .error(starting-timeout)` → derives `ERROR` |
| 2 | iOS `stop(timeout:)` | 10 s; **5 s** when called from `applicationWillTerminate` | Node not draining cleanly | `cleanup(threadExited: false)` → `ERROR` with phase `shutdown-timeout`. Node thread may still be alive — process death cleans up |
| 3 | iOS `waitForFile` (`NodeJSIPC`) | 30 s | Backend never binds the socket | IPC `.error` |
| 4 | iOS `connectWithRetry` | ~1.5 s budget (5 attempts, 100→200→400→800 ms) | File exists but `accept()` not yet ready | IPC `.error` |
| 5 | Android `startupTimeoutMs` | 30 s | Mirrors #1 | Sends `error-native` to backend (best-effort; see #7) **and** sets local `BackendState.Error(starting-timeout)` |
| 6 | Android `ComapeoCoreService.onDestroy` `withTimeout` | 10 s | `nodeJSService.stop()` hangs | Catches `TimeoutCancellationException` → `Process.killProcess`. This is the only outer bound on Android `stop()` — it has no internal timeout |
| 7 | Android `SEND_ERROR_NATIVE_TIMEOUT_MS` | 2 s | `ipcDeferred` never completes (FGS init threw before IPC was constructed) | Frame logged as dropped, no error thrown — the FGS still sets local `ERROR` regardless |
| 8 | Android `connectWithRetry` (`NodeJSIPC`) | 30 s | Backend never binds the socket OR file exists but `accept()` never ready | IPC `State.Error` |

**Backend (Node):**

| # | Where | Default | Guards against | On expiry |
|---|-------|---------|---------------|-----------|
| 9 | `handleFatal` flush window | 100 ms | `error` frame not flushed before `process.exit(1)` | Hard exit |
| 10 | `ServerHelper.listen` retry on `EADDRINUSE` | ~4 s (3 retries × 1 s) | Stale socket file blocking bind | Reject — caller surfaces ERROR with phase `listen-control` / `construct` |

**Unbounded waits (with safety nets, not internal timeouts):**

- **Backend `await initPromise` (`backend/index.js`).** No timeout on
  the rootkey-receive step. Relies on the native watchdog (#1 / #5)
  to break it via `error-native` → `process.exit(1)`. If both the
  watchdog and `error-native` fail, Node parks indefinitely and the
  main-app process sees `STARTING` until the OS kills the process.
  Defense-in-depth would be a 60–120 s `initPromise` timeout in the
  backend; not currently implemented.

- **Backend `await comapeo.close()` in the `shutdown` handler.**
  Bounded only by the caller-side stop timeout (#2 / #6). If
  `comapeo.close()` hangs internally, the native side fires
  `shutdown-timeout` and (on Android) the FGS process is killed.

- **Android `nodeJob?.join()` inside `NodeJSService.stop()`.** No
  internal timeout. Only the `withTimeout(10_000)` in
  `ComapeoCoreService.onDestroy` (#6) bounds it. Direct callers of
  `stop()` outside the FGS lifecycle must wrap in their own timeout.

- **`state.first { Connected }` in `NodeJSIPC.sendMessageInternal`.**
  Bounded indirectly: `disconnect()` cancels `connectJob`, which
  cancels the child `sendJob`, which cancels the suspending `first`.

**Worst-case latencies for cross-process error attribution (Android):**

- `error-native` lands: ~100 ms (flush window) from FGS-side ERROR to
  main-app receiving the precise phase.
- `error-native` dropped (#7): ~10–12 s from FGS-side ERROR to main-app
  receiving generic `node-runtime-unexpected` (FGS dies via `onError →
  stopService → onDestroy → withTimeout(10_000) → killProcess`; control
  socket closes; main-app's disconnect handler fires). State is
  correct; phase attribution is degraded.

---

## 6. Residual limitations

The per-component lifecycle model in §5 closes the previously-known
gaps. The remaining ones are inherent to the platform or out of scope:

- **Hard Node crashes still lack in-band detail.** A SIGSEGV in a
  native addon, an OOM kill by the OS, or `process.abort()` ends
  the process before any code (ours or the backend's) can broadcast
  an `error` frame. The control socket simply closes and the
  derivation lands in `ERROR` with the synthetic phase
  `node-runtime-unexpected` ("Backend disconnected unexpectedly").
  That's honest — there is no in-band detail to surface — but it
  means hard-crash diagnostics belong in a separate channel
  (Sentry / Crashlytics native crash reporting), not in
  `getLastError()`.

- **`error-native` requires a connected control IPC.** The FGS-side
  `error-native` channel (§5.5) preserves cross-process error
  attribution for FGS-local failures (rootkey, watchdog) when Node
  is alive. If the FGS fails *before* the control IPC has connected
  (a very narrow window — the IPC connect runs in the FGS service's
  init block alongside Node startup), the frame is dropped and the
  main-app process falls back to the synthetic
  `node-runtime-unexpected` phase. This is no worse than the
  pre-refactor baseline.

---

## 7. Sentry observability (optional)

Companion doc: [`sentry-integration-plan.md`](./sentry-integration-plan.md).
This section is the architectural overview; the plan has the
phasing, decision log, and per-file change list.

Sentry is **opt-in**. Consumers that don't register the Expo
config plugin and don't import the `@comapeo/core-react-native/sentry`
sub-export pay nothing — no DSN ends up in the APK/IPA, no
`io.sentry` classes are loaded at runtime, no Sentry-shaped
captures fire from this module.

### 7.1 Three event streams

Two tags split the emit sites in the dashboard:

- **`proc`** — actual OS process. iOS is always `main`. Android
  is `main` for code in the host UI process and `fgs` for code
  in the `:ComapeoCore` foreground-service process (Kotlin FGS
  code AND the embedded nodejs-mobile that runs there).
- **`layer`** — `rn` for the JS adapter, `native` for
  Kotlin/Swift, `node` for the embedded nodejs-mobile backend.

```
                              iOS (one process)         Android
                              ────────────────────      ─────────────────────────
  layer: rn    (JS adapter)   proc: main                proc: main
  layer: native (Kotlin/Swift) proc: main               proc: main + proc: fgs
  layer: node  (Phase 3)      proc: main                proc: fgs
```

What each emit site captures:

- **`layer:rn`** — `src/sentry.ts` adapter. State ERROR
  transitions → `captureException`; `messageerror` → warning;
  every state transition → breadcrumb.
- **`layer:native, proc:main` (Android main process)** —
  `ComapeoCoreModule.kt` (the RN bridge). Currently no native
  emits from this process; reserved for future use.
- **`layer:native, proc:fgs` (Android FGS) / `proc:main`
  (iOS)** — `SentryFgsBridge` (Android) / equivalent Swift
  bridge. `comapeo.boot` transaction with child spans
  `boot.fgs-launch` (Android only), `boot.extract-assets`
  (Android only, first boot after install/update),
  `boot.node-spawn`, and `boot.rootkey-load`. The
  "init frame sent" → "received: ready" breadcrumb pair marks the
  init-frame round-trip (no span — duration is dominated by the
  Node-side `boot.manager-init`). Plus state-transition
  breadcrumbs, control-frame breadcrumbs,
  FGS-lifecycle breadcrumbs (Android only), timeout events,
  rootkey-load `captureException`.
- **`layer:node`** — `@sentry/node` via `loader.mjs`. Per-RPC
  method spans, `handleFatal` `captureException`, and two top-level
  boot-phase root spans that share the FGS-side trace via
  `Sentry.continueTrace`: `boot.loader-init` (with two children,
  `boot.loader-import-sentry-node` and `boot.import-index`) and
  `boot.manager-init`. `listen-control` and `init` keep their phase
  tags for error attribution but no longer emit spans — they are
  reliably fast and (for `init`) duplicated by native
  `boot.rootkey-load`.

The same FGS-local error (rootkey load failure, watchdog
timeout) reaches multiple scopes via the cross-process
attribution path (§5.5): the FGS captures it directly, then
`error-native` re-broadcasts to Node which captures from the
node layer, and the `error` control frame propagates to the
main-app process where the JS adapter captures again. Sentry
de-dupes via fingerprinting; each vantage point carries
distinct context (FGS logcat / foreground state, node
stacktrace, RN state-machine trail).

### 7.2 Build-time config flow

The Expo config plugin (`app.plugin.js` at module root) is the
single source of truth for DSN / environment / release / sample
rates. At `expo prebuild` it writes:

- **Android**: meta-data on the main `<application>` tag
  (`com.comapeo.core.sentry.dsn`, `…environment`, `…release`,
  `…sampleRate`, `…tracesSampleRate`, `…rpcArgsBytes`,
  `…captureApplicationDataDefault`). meta-data is shared across
  processes within the package, so both the main process and
  the `:ComapeoCore` FGS process read the same values.
- **iOS**: keys in `Info.plist` with the `ComapeoCore` prefix
  (e.g. `ComapeoCoreSentryDsn`).

Native readers — `SentryConfig.kt` and `SentryConfig.swift` —
return a typed `SentryConfig?` (`null` when DSN is absent =
"Sentry off"). `release` defaults to
`versionName + "+" + versionCode` (Android) /
`CFBundleShortVersionString + "+" + CFBundleVersion` (iOS) when
the plugin didn't supply one, so successive EAS builds of the
same marketing version produce distinct release tags.

The module owns the RN-side `Sentry.init` lifecycle via
`initSentry()` (exported from `@comapeo/core-react-native/sentry`).
The host calls it once at app entry and passes allowlisted
extensions (integrations, `beforeSend`, `beforeBreadcrumb`, tags);
`initSentry` throws if the host has already called `Sentry.init`
separately. Locked options (dsn, environment, release, sampleRate,
tracesSampleRate, sendDefaultPii=false, enableLogs, user.id) come
from the plugin so all three hubs use the same values without the
host having to copy them.

The same plugin-baked subset is also exported as `sentryConfig` for
read-only inspection — empty `{}` when the plugin isn't registered.
It is NOT meant to be spread into a separate `Sentry.init` call;
`initSentry` is the supported entrypoint. Plugin-internal fields
(`rpcArgsBytes`, `captureApplicationDataDefault`) stay on the
native-side `SentryConfig` only.

The FGS process's Sentry SDK is initialised in
`ComapeoCoreService.onCreate` from the manifest meta-data —
because Android creates a fresh `Application` instance per
process, the host's `@sentry/react-native` (which inits in the
main `MainApplication`) doesn't reach the FGS. The bridge fills
that gap.

### 7.3 The FGS-side SDK init (Android)

`SentryFgsBridge.kt` owns `SentryAndroid.init(...)` inside the FGS
process. Android creates a fresh `Application` per process, so the
host's main-process `SentryAndroid.init` (from `@sentry/react-native`)
never reaches the FGS — the bridge re-runs init from
`ComapeoCoreService.onCreate` before `NodeJSService` is constructed.
This is the same pattern used on iOS, see §7.4.

A `@Volatile initialized` flag guards every public method so callers
that fire before init no-op silently. Each method also wraps its
Sentry call in a try/catch — a thrown Sentry path must never take
the FGS down.

`sentry-android` is now a regular `implementation` dep (not
`compileOnly`) because `@sentry/react-native` is a **mandatory peer
dep** of this module. Earlier design split the bridge into a guard
+ impl pair behind a `Class.forName` classpath probe; that
indirection became unnecessary once the SDK was guaranteed on the
classpath, and the two halves were merged back into a single
`SentryFgsBridge.kt`.

### 7.4 What this design *doesn't* attempt

- **Native crashes inside `nodejs-mobile`** (V8 abort, addon
  SIGSEGV, OOM) are not captured by us. They surface as host-
  process crashes that `sentry-android` / `sentry-cocoa`
  catches at the JNI/Cocoa layer. We do not bundle
  `sentry-native` into the embedded runtime.
- **iOS single-process equivalent of FGS init**. iOS is
  single-process, so the FGS-style separate-process init isn't
  needed — but we still own sentry-cocoa init natively, from
  `AppLifecycleDelegate.application(_:didFinishLaunchingWithOptions:)`
  via `SentryNativeBridge.initFromConfig`. The JS layer's
  `Sentry.init` runs with `autoInitializeNativeSdk: false`, so the
  native hub is the single owner of the SDK lifecycle. This keeps
  the boot transaction and pre-JS-bundle native spans on a live
  hub — the same invariant Android gets from
  `ComapeoCoreService.onCreate`.
- **DSN secrecy**. Sentry DSNs are not high-secret values —
  they identify a project rather than authenticate writes,
  and they appear in stripped binaries of every Sentry-using
  app's APK/IPA. Treating them as build-time public config is
  intentional.
- **PII capture**. Per the plan §7.4.9, observation contents,
  precise location, peer identities, raw project IDs, and
  user-entered text are never captured even with the
  capture-application-data toggle on.

### 7.5 Metadata reference

Single source of truth for what we emit. Constants live in
`SentryTags.{kt,swift}` / `src/sentry-tags.ts` (tags) and
`SentryCategories.{kt,swift}` / `src/sentry-tags.ts`
(breadcrumb categories). Update those files first, then
this table.

#### Tags (set on captureException / captureMessage / span)

| Key | Values | Where |
|---|---|---|
| `proc` | `main` (host UI process) · `fgs` (Android `:ComapeoCore`) | Process-level on FGS-side init; per-call on iOS, RN, and main-process Android |
| `layer` | `rn` · `native` · `node` (Phase 3) | Same as `proc` |
| `comapeo.phase` | `rootkey` · `node-runtime` · `starting-timeout` · `shutdown-timeout` · `node-runtime-unexpected` · `ipc` · `listen-control` · `init` · `construct` · `runtime` · `errorNativeForward` | Captured exceptions and timeout messages |
| `comapeo.state` | `STOPPED` · `STARTING` · `STARTED` · `STOPPING` · `ERROR` | ERROR captureExceptions only |
| `source` | `control-socket` · `rootkey-store` · `startNodeWithArguments` · `comapeo-core` (Phase 3) | Captured exceptions, narrows the origin within a phase |
| `timeout` | `startup` · `shutdown` · `fgsStop` · `errorNativeForward` · `waitForFile` · `connectRetry` | `captureMessage` events for timeout firings |
| `boot.kind` | `user-foreground` · `system-restart` | On `comapeo.boot` transactions (Android FGS only). `user-foreground` when the activity lifecycle initiated the start (stamped `serviceStartTimeMs`); `system-restart` when Android brought the FGS back without an intent — no `boot.fgs-launch` span and the timeline starts at `NodeJSService.start()`. |

#### Breadcrumb categories

| Category | What it carries | `data` fields |
|---|---|---|
| `comapeo.state` | Every state-machine transition | `from`, `to`, `backendState`, `nodeRuntime`, `stopRequested` (Android), `from`, `to` (iOS) |
| `comapeo.control` | Control-socket frames the parser accepted, plus malformed | `phase`+`message` (error frames), `detail` (malformed) |
| `comapeo.ipc` | NodeJSIPC connection-state transitions | `error` (only when `State.Error`) |
| `comapeo.fgs` | FGS lifecycle (Android only) | `startId`, `action`, `exitCode` (varies by callsite) |
| `comapeo.boot` | Boot-phase progress (start, asset copy, init frame, exit) | varies — `dir`, `exitCode`, etc. |

#### Spans

All boot phases use `op = name = "boot.<phase>"`. sentry-java's child-
span wire format has no separate `name` field — Discover renders
`span.name = op` for child spans, so the op carries the phase
identifier directly. The Node-side `name`/`op` fields are set to the
same value so all three layers (RN, native, Node) match. Filter the
whole boot timeline with `op:boot.*` in Discover.

| Operation | Layer | When it opens / closes |
|---|---|---|
| `comapeo.boot` (root tx) | `proc:fgs` Android / `proc:main` iOS | Opens in `NodeJSService.start()`; closes on first non-`STARTING` transition with status `ok` (STARTED), `internal_error` (ERROR), or `cancelled` (STOPPING/STOPPED). Forced 100% sampled; tagged `boot.kind=user-foreground` or `system-restart`. |
| `boot.fgs-launch` (Android only) | `proc:fgs` | Backdated to `serviceStartTimeMs` (stamped by the activity lifecycle listener); closes immediately on entry to `NodeJSService.start()`. `user-foreground` boots only — absent on `system-restart`. |
| `boot.extract-assets` (Android only) | `proc:fgs` | Recursive copy of `nodejs-project/` from APK assets into internal storage. Opened only when `shouldCopyAssets()` returns true — i.e. first boot after install or app update. Presence in a trace is itself diagnostic ("this was a cold start after update"); absent on every subsequent boot. iOS reads the bundle in place (no extraction). |
| `boot.node-spawn` | `proc:fgs` Android / `proc:main` iOS | JNI call to `startNodeWithArguments` (Android) / `nodeEntryPoint` (iOS) → backend's `started` frame on the control socket. Spans the C/C++ V8-bootstrap phase plus the Node-side loader/import/manager-init phases (visible as nested child transactions on the same trace). |
| `boot.loader-init` | `layer:node` | Backdated to `loader.mjs` first line; closed just after `Sentry.init`. Covers the C/C++ → JS handover including V8 bootstrap and the iitm hook install. Has two child spans: `boot.loader-import-sentry-node` (brackets `import("@sentry/node")` — the dominant chunk on the reference device) and `boot.import-index` (brackets the dynamic `import("./index.js")`). The gap between loader-init's duration and the import-sentry-node child is parseArgs + iitm `register()` + smaller imports + `Sentry.init` (collectively <200ms on the reference device; no spans of their own). `boot.import-index` parents to loader-init via an explicit `parentSpan` reference (not via AsyncLocalStorage) so the IIFE inside `index.js` still captures `boot.node-spawn` as the parent for `boot.manager-init` — keeping it a top-level Node phase rather than nesting it further. Sentry renders import-index as a child whose duration extends past its parent's. |
| `boot.manager-init` | `layer:node` | Wraps `createComapeo(...)` + `comapeoRpcServer.listen(...)` — drizzle migrations + SQLite open + hypercore init + fastify + RPC socket bind. |
| `boot.rootkey-load` | `proc:fgs` Android / `proc:main` iOS | Wraps `RootKeyStore.loadOrInitialize()` (Android) / `RootKeyStore.loadKey()` (iOS) in `sendInitFrame()`. Span data: `generated=true` on first install, `false` on steady-state. |

Cross-layer trace propagation: native opens `comapeo.boot`, then
forwards the `boot.node-spawn` span's `sentry-trace` header to the
Node process as the `--sentryTrace` argv flag. The Node side's
`Sentry.continueTrace` wraps all three Node-side boot spans so they
inherit the FGS-side trace_id and parent_span_id. Result: every boot
span across all three layers shares a single trace, viewable on a
single timeline in Sentry's Trace view. Cross-layer with the RN-side
`App Start` transaction is tracked in
[#68](https://github.com/digidem/comapeo-core-react-native/issues/68).

#### Standard captureMessage events

| Message | Level | Tags |
|---|---|---|
| `comapeo: startup timeout fired` | `error` | `timeout:startup`, `comapeo.phase:starting-timeout` |
| `comapeo: stop timeout fired` (iOS) / `comapeo: FGS stop timeout fired` (Android) | `error` | `timeout:shutdown` (iOS) / `timeout:fgsStop` (Android), `comapeo.phase:shutdown-timeout` |
| `comapeo: error-native frame dropped` (Android FGS) | `warning` | `timeout:errorNativeForward`, `comapeo.phase:<inner>` |

#### Standard captureException tag sets

| Origin | `comapeo.phase` | `source` | `comapeo.state` | Where |
|---|---|---|---|---|
| Rootkey-store load failure | `rootkey` | `rootkey-store` | `ERROR` | FGS-side (Android) and iOS native |
| Node-runtime launch failure | `node-runtime` | `startNodeWithArguments` | `ERROR` | Android FGS only (iOS lifts the throw via the same path) |
| Synthesised JS-side ERROR | from `info.errorPhase` | (none) | `ERROR` | `src/sentry.ts` |
| Control-socket parse failure | (none) | `control-socket` | (none, level `warning`) | `src/sentry.ts` |

The plan's §7.4.9 never-capture list is enforced at every emit
site (no observation contents, precise location, peer
identities, raw project IDs, or user-entered text). Phase 5's
`before_send` processor will add a defensive substring scrub
on top.

### 7.6 When to log, when to breadcrumb, when to capture

Logs, breadcrumbs, and captured events serve different
purposes and shouldn't be 1-to-1.

| | Logs (`logcat` / `os_log`) | Breadcrumbs | Captured events (`captureException` / `captureMessage`) |
|---|---|---|---|
| Cost | Unbounded — OS rotates the buffer | Finite ring buffer (Sentry's default 100 per scope) | Counted toward Sentry quota; surface as Issues |
| Visibility | Live during local debug only | Attached to next captured event | First-class dashboard entries |
| Audience | Developer at the keyboard | Reader of a captured event later | Triage reader |
| Use for | Anything | Lifecycle context | Errors / notable non-error events |

The codebase has four helpers. `log()` is the foundation;
the other three compose on top of it:

- **`log(message, level, attributes)`** — the single
  primitive. Always writes a logcat / os_log line at the
  matching priority; also forwards to Sentry's
  structured-log pipeline (`Sentry.logger.*` Android,
  `SentrySDK.logger.*` iOS), which the SDK gates on
  `enableLogs`. Use for debug noise, cache-check diagnostics,
  guard-rejection paths.
- **`logCrumb(category, message, level, data)`** — `log()`
  + Sentry breadcrumb. Lifecycle progress events: state
  transitions, control-socket frames, IPC state, FGS
  lifecycle, boot phases. ~20–25 emissions per app session,
  well under the breadcrumb buffer cap.
- **`logException(category, throwable, message, tags)`** —
  `log()` (with throwable, so the stack lands in logcat via
  3-arg `Log.e(TAG, msg, t)`) + `captureException`. Use when
  you have a `Throwable` in hand. Examples: rootkey-load
  failure, node-runtime launch failure.
- **`logCapture(category, message, level, tags)`** —
  `log()` + `captureMessage`. Use when you don't have a
  throwable but the event is notable: timeouts (startup,
  shutdown, fgsStop, errorNativeForward), dropped frames,
  protocol violations.

Plus one more shape that doesn't go through the helpers:
**breadcrumb only** is used by `src/sentry.ts` (the JS
adapter) on Android — the matching FGS-side `logCrumb`
already produces the logcat line; emitting from JS too
would just round-trip through Metro's bridge.

`captureException` vs `captureMessage` — when in doubt:
have a throwable → `logException`; making a synthetic
exception just to use captureException would lose the
"this isn't really a stack-traceable error" semantic and
the dashboard's grouping wouldn't be useful.

**iOS dual-crumb caveat.** On iOS, single-process means both
the native bridge's breadcrumb and the JS adapter's breadcrumb
land on the same Sentry hub for every state transition. They
carry different `data` payloads (native has the full
`(backendState, nodeRuntime, stopRequested)` triple; JS has
the simplified state derivation), so they're complementary,
but they do roughly halve the effective lookback window. The
JS adapter is the resilience layer when the native bridge is
gated off (`#if canImport(Sentry)` false), so we keep both.

**Phase 3 forward-look.** When backend RPC tracing lands, do
NOT `logCrumb` every RPC method call — a noisy sync session
can fire 100+ RPCs and evict every boot/state crumb from the
buffer. The right shape is: log per RPC (cheap), crumb only
on RPC errors, and let the sampled-trace span infrastructure
(`tracesSampleRate`) handle the success path.

**Sentry structured logs.** Sentry has a separate "Logs"
pipeline (`SentrySDK.logger.*` / `Sentry.logger.*`),
queryable independently in the Logs UI and *not* attached
to events the way breadcrumbs are. Our `log()` primitive
forwards every call through this pipeline; the SDK gates
on `enableLogs` so it costs nothing for consumers who
haven't opted in.

To enable: set `enableLogs: true` on the
`@comapeo/core-react-native` plugin (controls the Android
FGS-process hub, where we own the SDK init) and on
`Sentry.init({ enableLogs: true, ... })` in the host app
(controls the main-process hub on Android and the
single-process hub on iOS — that init is the host's, not
ours, on those paths). When enabled, every `log` /
`logCrumb` / `logException` / `logCapture` call lands in
the Logs UI in addition to its primary destination,
giving cross-process timeline reconstruction across
`proc:main` / `proc:fgs` / `proc:node` (breadcrumbs don't
cross scopes; logs do).

---

## 8. Alternatives considered

### 8.1 FGS↔main process state notification (Android)

The current approach (§4.4) is a second `NodeJSIPC` connection to
`control.sock`. We considered:

| Mechanism | Late-join | Cross-process | Boilerplate | Verdict |
|---|---|---|---|---|
| Intent broadcast (`sendBroadcast`) | No (sticky deprecated) | Yes | Low | Reject — fire-and-forget without replay; would need a query-current-state side channel |
| `LocalBroadcastManager` | n/a | **No** | n/a | Reject — in-process only, doesn't cross `:ComapeoCore` boundary |
| `Messenger` / bound service | Manual snapshot on bind | Yes | Moderate (~100 LOC) | Reject — moves state into Kotlin, duplicates Node's state machine, breaks "Node owns the truth" |
| AIDL bound service | Same | Yes | High (~150–200 LOC) | Reject — typed RPC overkill for one-way state notifications |
| `ContentProvider` + `ContentObserver` | **Free** (re-query) | Yes | Moderate (~100 LOC) | Runner-up. Late-join free; only structural advantage. Not worth ~100 LOC of new manifest/provider/observer code today. |
| `FileObserver` on a state file | Free | Yes | Low | Reject — documented unreliability under load; bad for a state machine |
| `ParcelFileDescriptor.createPipe` | Manual | Yes | Moderate | Reject — a transport, not a notification mechanism; would still need a service + protocol on top |
| **Second `NodeJSIPC` (current)** | Replay in Node | Yes | Low (~30 LOC) | **Selected.** Reuses existing socket client class; replay logic lives in JS where the rest of the lifecycle lives; iOS uses the in-process equivalent so the "Node owns the truth" abstraction holds across platforms. |

The strongest case against the current approach is "it's a second
persistent socket paying connection overhead and a 50 ms retry poll
for a channel that carries ~6 messages per process lifetime." That cost
is real but small. If profiling later shows it matters, **ContentProvider
+ ContentObserver** is the runner-up.

### 8.2 Rootkey storage: Why not `expo-secure-store`?

Detailed comparison: see
[`root-key-storage-and-migration-plan.md`](./root-key-storage-and-migration-plan.md).

The summary: `expo-secure-store`'s core failure-mode policy is
"silently delete on `BadPaddingException` / `KeyPermanentlyInvalidatedException`,
return null." That is correct for tokens you can re-fetch; for a 16-byte
never-rotated device identity it is exactly the bug we cannot ship.

What our `RootKeyStore` does that `expo-secure-store` doesn't:

- `setIsStrongBoxBacked(true)` with graceful fallback (Pixel/Titan-M
  hardware-backed keys when available).
- `setUnlockedDeviceRequired(true)` on P+ — `expo-secure-store`'s
  at-rest data is decryptable by the running app even on a locked
  device.
- `setRandomizedEncryptionRequired(true)` explicitly.
- Integer envelope version (`v: 1`) with strict mismatch throw —
  `expo-secure-store` uses a `scheme` string + boolean; no monotonic
  version for future migrations.
- Read-back verification (decrypt + byte-compare after write).
- Throws rather than silently regenerates on any decrypt failure.
- Backup exclusion baked into the module (`fullBackupContent` +
  `dataExtractionRules`); `expo-secure-store` leaves backup policy to
  the host app, which is a known footgun (Auto Backup mirrors prefs to
  Drive, the wrapper key doesn't go with it, restored device hits the
  silently-delete path).

Replacing ours would require either patching the upstream module or
wrapping it to convert "returned null but blob existed" into a thrown
exception, at which point most of `RootKeyStore` is reimplemented plus
transitive deps on `expo-modules-core`, `kotlinx-coroutines`, and
`androidx.biometric`.

Net: ~215 lines of ours doing exactly what we need with stronger
at-rest properties; `expo-secure-store` is ~740 lines doing a
different problem.

### 8.3 Single-socket variants

Earlier prototypes carried lifecycle frames over the comapeo socket
(prepended to the RPC stream). Rejected because:
- The bind timing diverged from RPC needs (rootkey before manager
  construction).
- Mixing types forced every RPC client to filter unwanted frames.
- The replay semantics for `started`/`ready` only make sense for the
  control surface; carrying replay through RPC was nonsense.

### 8.4 Eager rootkey injection

Prototype: ship the rootkey in `argv` to the Node process so the
backend reads it from `process.argv[N]` on boot, no handshake needed.
Rejected because:
- argv is process-wide visible (`/proc/<pid>/cmdline` on Android, `ps`
  on iOS-with-jailbreak); secrets in argv leak to anything that can
  enumerate processes.
- Logging the argv (which we sometimes do for debugging) would dump the
  rootkey. The handshake keeps the secret out of long-lived strings.

The handshake costs one round-trip plus one socket bind ordering
constraint. Both are small.

---

## 9. References

- `backend/index.js` — boot sequence, `handleFatal`, init handler.
- `backend/lib/simple-rpc.js` — control socket server, replay, error
  broadcast.
- `ios/NodeJSService.swift`, `android/.../NodeJSService.kt` — native
  lifecycle state.
- `src/ComapeoCoreModule.ts` — JS-facing observers (`comapeo`, `state`).
- `docs/sentry-integration-plan.md` — Sentry integration plan (§7
  is the architectural overview).
- [GitHub issue #29](https://github.com/digidem/comapeo-core-react-native/issues/29)
  — original "expose Node.js lifecycle state to JS" tracking issue.
