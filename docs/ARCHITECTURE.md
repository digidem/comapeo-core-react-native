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
inside the backend process. Native code connects as a client.

#### `comapeo.sock` — application RPC

Carries `@comapeo/ipc` request/response traffic. Bound by Node.js
(`ComapeoRpcServer.listen(comapeoSocketPath)`) only AFTER `MapeoManager`
has been constructed. The main app process connects and uses
`createMapeoClient(messagePort)` to expose a typed RPC client to JS
(`src/ComapeoCoreModule.ts`'s `comapeo` export).

A late connection (i.e. the React Native module connects after Node has
already bound this socket) is the steady state: the backend always binds
this socket some hundreds of milliseconds after process start. The
`NodeJSIPC.waitForFile()` poll handles the gap.

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
| Node → native | `{type:"error",phase,message,stack?}` | Boot failure or uncaught throw at any phase. |
| Native → Node | `{type:"shutdown"}` | Native requests graceful shutdown. |

**Replay semantics.** `SimpleRpcServer` (`backend/lib/simple-rpc.js`)
remembers its last readiness phase and replays `started` and `ready` to
any client that connects after they were broadcast. Without replay a
late-connecting client (the React Native module on Android races the
FGS's IPC client; both connect to the same socket, see §4) would miss
the events that already fired.

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
                │             │                     │  (waitForFile +  │
                │             │                     │   retry)         │
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

This is where the architecture is honest: see §6 for known limitations.

### 5.1 Native state

`NodeJSService.State` (both platforms) has five values:

```
STOPPED   — initial; not running.
STARTING  — Node spawned (or about to be). Awaiting `ready`.
STARTED   — `MapeoManager` constructed; RPC safe.
STOPPING  — graceful shutdown initiated.
ERROR     — observable failure (rootkey load, backend boot,
            shutdown timeout, IPC connect, control-socket error
            frame, watchdog timeout).
```

Driven by:
- `start()` → `STARTING`
- control-socket `{type:"ready"}` → `STARTED`
- control-socket `{type:"error"}` or local rootkey/init failure
  or watchdog timeout (default 30s) → `ERROR` with `ErrorInfo{phase, message}`
- `stop()` → `STOPPING`
- node thread exit + clean shutdown path → `STOPPED`
- `cleanup(threadExited: false)` (e.g. `stop()` timeout) → `ERROR`

`ERROR` is **observable but does not tear down the node thread**.
Recovery is the application's responsibility (restart the FGS on
Android, re-create the service on iOS, prompt the user, log a report).

### 5.2 JS-visible state

`ComapeoState` (`src/ComapeoCore.types.ts`) is the same union, exposed
to React Native as `state.getState()` and the `stateChange` event. The
event payload carries optional `errorPhase` / `errorMessage` when the
state is `ERROR`; `state.getLastError()` returns the structured detail.

### 5.3 Native ↔ JS plumbing

**iOS** (`ios/ComapeoCoreModule.swift`): in-process callback —
`AppLifecycleDelegate.nodeService.onStateChange = { state in
sendEvent("stateChange", payload) }`. Payload includes
`state.getLastError()` when the state is `.error`.

**Android** (`ComapeoCoreModule.kt`, main app process): derived from
the second `NodeJSIPC` connection's combination of:
- Control-socket frames (`started`, `ready`, `error`).
- The IPC's own connection state (`Connecting`, `Connected`,
  `Disconnecting`, `Disconnected`, `Error{cause}`).

The derivation is in `setState(...)` and the two `controlIpc` callbacks
in `OnCreate`. `getLastError()` is exposed via a native `Function`.

### 5.4 Errors

Three failure surfaces, all converging on `ERROR`:

1. **Local native failures**: rootkey load, JS entry point not found,
   stop timeout, watchdog timeout. Tagged with phases like `rootkey`,
   `node-runtime`, `shutdown-timeout`, `starting-timeout`.
2. **Backend-reported failures**: `process.on("uncaughtException")` and
   `process.on("unhandledRejection")` route through `handleFatal(phase,
   error)` which calls `controlIpcServer.broadcastError({phase, message,
   stack})` and exits 1 after a 100 ms flush wait. Phases: `init`,
   `listen-control`, `construct`, `runtime`.
3. **IPC-level failures**: `NodeJSIPC.State.Error` is mapped to `ERROR`
   with phase `ipc`. Phase distinguishes "connection layer broke" from
   "backend reported an error".

---

## 6. Known limitations & proposed direction

### 6.1 The state machine merges three independently-stateful layers

The current `NodeJSService.State` is one variable, but it is driven by
three components whose states are not actually one thing:

1. **The Foreground Service container** (Android only) — running, not
   running, stopped by user.
2. **The Node runtime / thread** — `startNodeWithArguments` not yet
   called; in flight; returned with exit code N. The runtime can exit
   for reasons that do not cross the control socket (e.g. SIGSEGV in a
   native addon, OOM, an unrecoverable `process.abort()`).
3. **The backend JS code** — pre-listening, control-bound, ready,
   errored. This is the only one whose state we currently surface.

When these states agree, the merge is fine. When they disagree, the
current implementation has gaps:

- **Node exits cleanly without an error frame.** Today: state
  transitions to `STOPPED` via the `finally` block in `start()` (Android)
  / nothing happens (iOS, the runNode exit signals the completion sem
  but no state transition happens unless someone calls `stop()` or
  `cleanup()`). On the main app process (Android) the control socket
  closes and we transition to `STOPPED` via `NodeJSIPC.State.Disconnected`.
  All of these are wrong if the exit was unexpected.
- **Node crashes (non-zero exit) without an error frame.** Same shape;
  we don't distinguish "node threw an uncaught exception that bypassed
  our handler" from "graceful shutdown".
- **The FGS-side `NodeJSService` errors locally (rootkey load fails) but
  the main app process doesn't see it directly.** This is now handled
  by the recently-added `{type:"error"}` broadcast (see §5.4) — but the
  transport is the control socket, which is itself a fragile signal: if
  the FGS-side rootkey load fails before the control socket has bound,
  there's no channel to broadcast on.

### 6.2 Proposed direction: per-component state

Model each of the three components as its own state, and derive the
single `ComapeoState` exposed to JS as a pure function of those inputs:

```
  Intent        ∈ {Stopped, Starting, Stopping}
                  (user-requested target — what we're aiming at)

  FgsState      ∈ {NotRunning, Foreground, Stopped}
                  (Android only; trivially Foreground on iOS)

  NodeRuntime   ∈ {NotRunning, Running, Exited(code, reason)}
                  (where reason ∈ {requested, unexpected})

  BackendState  ∈ {Unknown, ControlBound, Ready, Error{phase,message}}
                  (sourced from control-socket frames)

  IpcState      ∈ {Disconnected, Connecting, Connected, Error{cause}}
                  (per-socket — already exists in NodeJSIPC)
```

`deriveComapeoState(...)` is then a small decision tree:

```
  Intent.Stopped + NodeRuntime.NotRunning             → STOPPED
  Intent.Starting + BackendState.Ready                → STARTED
  Intent.Starting + BackendState.Error                → ERROR
  Intent.Starting + NodeRuntime.Exited(_, unexpected) → ERROR
  Intent.Starting + IpcState.Error                    → ERROR
  Intent.Starting + (anything else)                   → STARTING
  Intent.Stopping + NodeRuntime.Exited(_, requested)  → STOPPED
  Intent.Stopping + (anything else)                   → STOPPING
  // ... etc.
```

Benefits:

- Errors are precisely attributable. An ERROR transition carries which
  component's state caused it.
- Node exit without an error frame is naturally handled — `NodeRuntime`
  becomes `Exited(_, unexpected)` and the derivation produces `ERROR`.
- Race conditions between components are reasoned about as
  state-merging in a pure function rather than ad-hoc transitions.
- Tests can drive each component's state independently; today they have
  to drive a real (or mock) backend to exercise the merged state.

Costs:

- More state types and more transitions to maintain.
- The derivation function needs to be carefully designed and tested.
- The main app process (Android) currently has no way to observe
  `NodeRuntime.Exited(_, unexpected)` — that information lives in the
  FGS process. We'd need either a side channel (file write on exit,
  Messenger, ContentProvider) or a control-socket convention (e.g.
  backend broadcasts `{type:"stopping"}` before its shutdown handler
  closes, so an unannounced disconnect is unambiguously unexpected).

A simpler intermediate fix is option (a) below; the per-component model
is option (b).

#### 6.2.a Intermediate fix: announce shutdown-in-progress

Backend's `shutdown` handler broadcasts `{type:"stopping"}` BEFORE
closing servers. Native (both FGS-side and main-app-side on Android)
tracks an `expectingDisconnect` flag set by either `stopping` or
`error` frames. On `controlIpc.Disconnected`:

- If `expectingDisconnect` was set, transition to `STOPPED`.
- If not, transition to `ERROR` with phase `node-exit-unexpected`.

This catches the "node exits without an error frame" case without
introducing per-component state. ~30 LOC of Kotlin/Swift on each
platform plus one broadcast in the backend.

#### 6.2.b Bigger fix: per-component state

The model above. Estimated cost: ~200 LOC of new Kotlin/Swift state
types + a derivation function, tests for the derivation, refactor of
the existing `transitionState` / `transitionToError` callers to update
the appropriate component-state instead. The derivation function is
shared across platforms in spirit but not in code (one each in Kotlin
and Swift), and the JS layer doesn't change.

This is a candidate for a follow-up PR; it does not block the current
rootkey work shipping.

---

## 7. Alternatives considered

### 7.1 FGS↔main process state notification (Android)

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
persistent socket paying connection overhead and a `waitForFile` poll
for a channel that carries ~6 messages per process lifetime." That cost
is real but small. If profiling later shows it matters, **ContentProvider
+ ContentObserver** is the runner-up.

### 7.2 Rootkey storage: Why not `expo-secure-store`?

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

### 7.3 Single-socket variants

Earlier prototypes carried lifecycle frames over the comapeo socket
(prepended to the RPC stream). Rejected because:
- The bind timing diverged from RPC needs (rootkey before manager
  construction).
- Mixing types forced every RPC client to filter unwanted frames.
- The replay semantics for `started`/`ready` only make sense for the
  control surface; carrying replay through RPC was nonsense.

### 7.4 Eager rootkey injection

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

## 8. References

- `backend/index.js` — boot sequence, `handleFatal`, init handler.
- `backend/lib/simple-rpc.js` — control socket server, replay, error
  broadcast.
- `ios/NodeJSService.swift`, `android/.../NodeJSService.kt` — native
  lifecycle state.
- `src/ComapeoCoreModule.ts` — JS-facing observers (`comapeo`, `state`).
- [GitHub issue #29](https://github.com/digidem/comapeo-core-react-native/issues/29)
  — original "expose Node.js lifecycle state to JS" tracking issue.
