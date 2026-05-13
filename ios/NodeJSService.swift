import Foundation

/// Manages the lifecycle of an embedded Node.js process on iOS.
///
/// Unlike Android (which uses a foreground service in a separate process), iOS runs
/// Node.js in-process. Graceful shutdown is triggered when the app is about to be
/// terminated (`applicationWillTerminate`).
///
/// ## State model
///
/// The public `state: State` is a *derived* value. Internally the
/// service tracks three independently-stateful components and computes
/// `state` as a pure function of them via `deriveState`:
///
/// - `nodeRuntime`: whether the Node.js thread is not running, running,
///   or exited (with a reason).
/// - `backendState`: what the backend has told us via control-socket
///   frames (`started`, `ready`, `stopping`, `error`).
/// - `stopRequested`: whether `stop()` has been called this lifetime.
///
/// Replacing the previous single-variable model with derived state
/// makes "node exits without a control frame" detectable: the
/// `nodeRuntime` becomes `.exited(_, .unexpected)` and the derivation
/// produces ERROR deterministically. Each ERROR transition carries
/// which component caused it via `_lastError`.
class NodeJSService {
    /// Lifecycle states. Mirrors Android's `NodeJSService.State` 1:1.
    /// This is a *derived* state — see `deriveState` for the inputs.
    ///
    /// **`.error` is per-instance terminal.** `start()` and `stop()`
    /// are refused once the service has entered `.error`; the only way
    /// out is `cleanup()` (which lands in `.stopped` if the node thread
    /// has actually exited, or `.error` again if it hasn't) followed
    /// by creating a fresh `NodeJSService` instance. The node thread
    /// may still be alive when `.error` is set (this layer does not
    /// tear it down on error); `cleanup()` is what releases it.
    enum State: String {
        case stopped = "STOPPED"
        case starting = "STARTING"
        case started = "STARTED"
        case stopping = "STOPPING"
        case error = "ERROR"
    }

    /// Structured detail attached to .error transitions sourced from the
    /// backend's `{type:"error",phase,message,stack?}` control frame, or
    /// from local rootkey-load / startup failures, or synthesized when
    /// the node thread exits unexpectedly without a frame. `phase`
    /// mirrors the backend's phase strings (`listen-control`, `init`,
    /// `construct`, `runtime`) plus the local `rootkey`,
    /// `starting-timeout`, `shutdown-timeout`, `node-runtime-unexpected`,
    /// `node-runtime`.
    struct ErrorInfo: Equatable {
        let phase: String
        let message: String
    }

    // MARK: - Component state (derivation inputs)

    /// Whether the Node.js runtime thread is running, not yet started, or has
    /// exited. The `exited` reason distinguishes a graceful exit (we asked
    /// for it via `stop()` or saw a `stopping` frame) from an unexpected
    /// one (thread returned without us asking) — the latter derives to
    /// `.error` so a crash in a native addon or an unrecoverable
    /// `process.abort()` is observable as ERROR rather than STOPPED.
    enum NodeRuntimeState: Equatable {
        case notRunning
        case running
        case exited(code: Int32, reason: ExitReason)
    }

    enum ExitReason: Equatable {
        /// `stop()` was called or the backend broadcast `{type:"stopping"}`
        /// before the thread exited. The graceful path.
        case requested
        /// The thread returned without a preceding stop signal. Derives
        /// to ERROR via `deriveState`.
        case unexpected
    }

    /// What the backend has told us via control-socket frames, plus local
    /// failures that share the same conceptual slot (rootkey load,
    /// watchdog timeout). Mirrors the boot phases the backend tags errors
    /// with, with `unknown` for "no frames yet" and `controlBound` for
    /// "received `started`, awaiting init→ready".
    enum BackendState: Equatable {
        case unknown
        case controlBound
        case ready
        case stopping
        case error(phase: String, message: String)
    }

    /// A blocking function that runs the Node.js runtime.
    /// Takes an array of arguments (e.g. ["node", jsPath, ...]) and blocks until Node exits.
    /// Returns the exit code.
    typealias NodeEntryPoint = (_ arguments: [String]) -> Int32

    /// Returns the 16-byte rootkey + `generated` flag (true on first
    /// install — surfaced as span data on `boot.rootkey-load`). Called
    /// once per `start()`, off the main thread, after control IPC
    /// connect and Node `started`.
    typealias RootKeyProvider = () throws -> RootKeyResult

    static let comapeoSocketFilename = "comapeo.sock"
    static let controlSocketFilename = "control.sock"

    private let socketDir: String
    /// Backend's `privateStorageDir` argv positional. Mirrors Android's
    /// `dataDir` (see NodeJSService.kt). The embedded ComapeoManager opens
    /// SQLite files and other on-disk state under here, so it must be a
    /// writable, app-private location that survives across process restarts
    /// (e.g. `~/Library/Application Support/comapeo` on iOS).
    private let privateStorageDir: String
    let comapeoSocketPath: String
    let controlSocketPath: String
    private var controlIPC: NodeJSIPC?
    private var nodeThread: Thread?
    private let lock = NSLock()

    /// Signaled by the node thread when it has finished exiting.
    private var nodeCompletionSemaphore: DispatchSemaphore?

    /// The function used to start Node.js. Can be replaced for testing.
    private let nodeEntryPoint: NodeEntryPoint

    /// How to locate the bundled JS entry point. Can be replaced for testing.
    private let resolveJSEntryPoint: () -> String?

    /// Reads the rootkey on demand. Can be replaced for testing so the
    /// macOS swift-test target never touches the real keychain.
    private let rootKeyProvider: RootKeyProvider

    /// Maximum time the service may stay in `.starting` before the
    /// watchdog forces a transition to `.error`. Configurable so tests
    /// (and slow CI environments) can tighten or relax it. The watchdog
    /// guards against backend hangs that leave Node parked without ever
    /// emitting `ready` — without it, `.starting` would be a black hole.
    private let startupTimeout: TimeInterval

    /// Active watchdog work item. Set in `start()`, cancelled when the
    /// service transitions out of `.starting` (to `.started`, `.error`,
    /// `.stopping`, or `.stopped`). Stored under `lock`.
    private var startupWatchdog: DispatchWorkItem?

    /// Sentry boot transaction handle. Opened in `start()`, closed
    /// on the first non-`.starting` transition by `applyAndEmit`.
    /// `Any?` keeps `Sentry` types out of this file's signatures —
    /// the bridge handles the cast.
    ///
    /// Touched from multiple threads (`start` from the consumer,
    /// `sendInitFrame` from the IPC receive queue, the drain in
    /// `applyAndEmit` from any caller). Every read and write goes
    /// through `bootSentryQueue.sync`; bridge calls happen outside
    /// the queue, same no-callbacks-under-sync discipline as
    /// `lock`.
    fileprivate var bootTransaction: Any?

    /// In-flight `boot.<phase>` spans, keyed by phase. Drained by
    /// `applyAndEmit` on terminal transition. Same threading
    /// discipline as `bootTransaction`.
    fileprivate var bootSpans: [String: Any] = [:]

    /// Serial queue that owns access to `bootTransaction` and
    /// `bootSpans`. `sync` is enough — the held work is just
    /// snapshot-and-mutate, never an external callback.
    fileprivate let bootSentryQueue = DispatchQueue(
        label: "com.comapeo.core.bootSentry"
    )

    var onStateChange: ((State) -> Void)?

    /// Fires for control-socket frames the receiver can't process
    /// (non-JSON, unknown / empty `type`). Mirrors DOM `MessagePort`'s
    /// `messageerror`: a malformed frame is reported on a separate
    /// channel rather than transitioning to `.error`. Subscribed by
    /// `ComapeoCoreModule` to forward as a JS-visible event.
    var onMessageError: ((String) -> Void)?

    /// Cached derivation of the public lifecycle state. Recomputed by
    /// `applyAndEmit` after every component-state mutation; kept as a
    /// stored property so external readers (`ComapeoCoreModule`) get
    /// O(1) access without having to take the lock.
    private(set) var state: State = .stopped

    // Component state (all mutated only under `lock`).
    private var nodeRuntime: NodeRuntimeState = .notRunning
    private var backendState: BackendState = .unknown
    private var stopRequested: Bool = false

    /// Last error detail observed during this service's lifetime. Set
    /// by `applyAndEmit` when a transition lands in `.error`. Reads are
    /// guarded by `lock`; consumers should call `getLastError()` rather
    /// than reading the storage directly.
    private var _lastError: ErrorInfo?

    func getLastError() -> ErrorInfo? {
        lock.lock()
        defer { lock.unlock() }
        return _lastError
    }

    /// Forwarded as `--sentry*` argv flags to `backend/loader.mjs`.
    /// `nil` → loader skips Sentry.
    private let sentryConfig: SentryConfig?

    /// Creates a NodeJSService with a custom directory.
    /// - Parameters:
    ///   - socketDir: Directory holding the Unix-domain socket files
    ///     `NodeJSService` binds. Path is constrained to the 104-byte
    ///     `sockaddr_un.sun_path` limit (Darwin); the precondition in
    ///     `init` enforces it loudly.
    ///   - privateStorageDir: App-private writable directory passed to the
    ///     backend as the third argv positional. The embedded ComapeoManager
    ///     keeps SQLite, blobs, and other on-disk state here.
    ///   - nodeEntryPoint: Blocking function that runs Node.js.
    ///   - resolveJSEntryPoint: Returns the path to the JS entry file.
    ///   - rootKeyProvider: Returns the 16-byte device rootkey. Invoked
    ///     during `starting` after the backend's `started` broadcast.
    ///   - sentryConfig: Optional Sentry config; defaults to
    ///     `SentryConfig.loadFromMainBundle()` for production
    ///     callers. Tests pass `nil`.
    ///   - startupTimeout: Maximum seconds in `.starting` before the
    ///     watchdog forces `.error`. Default 30s covers cold simulator
    ///     boots plus addon dlopens with margin; production callers may
    ///     widen for slow devices, tests may tighten.
    init(
        socketDir: String,
        privateStorageDir: String,
        nodeEntryPoint: @escaping NodeEntryPoint,
        resolveJSEntryPoint: @escaping () -> String?,
        rootKeyProvider: @escaping RootKeyProvider,
        sentryConfig: SentryConfig? = SentryConfig.loadFromMainBundle(),
        startupTimeout: TimeInterval = 30
    ) {
        self.socketDir = socketDir
        self.privateStorageDir = privateStorageDir
        self.sentryConfig = sentryConfig
        self.comapeoSocketPath = (socketDir as NSString).appendingPathComponent(NodeJSService.comapeoSocketFilename)
        self.controlSocketPath = (socketDir as NSString).appendingPathComponent(NodeJSService.controlSocketFilename)

        // Fail loudly if either socket path won't fit in sockaddr_un.sun_path
        // (104 bytes on Darwin, including the null terminator). A silently
        // truncated path causes bind() to succeed against a different file —
        // surfacing later as a mysterious connection-refused or hang.
        let sunPathMax = 104
        for path in [comapeoSocketPath, controlSocketPath] {
            let needed = path.utf8.count + 1
            precondition(
                needed <= sunPathMax,
                "Socket path too long for sockaddr_un.sun_path (\(needed) > \(sunPathMax)): \(path)"
            )
        }

        self.nodeEntryPoint = nodeEntryPoint
        self.resolveJSEntryPoint = resolveJSEntryPoint
        self.rootKeyProvider = rootKeyProvider
        self.startupTimeout = startupTimeout

        try? FileManager.default.createDirectory(atPath: socketDir, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(atPath: privateStorageDir, withIntermediateDirectories: true)
        deleteSocketFiles()
    }

    // MARK: - Derivation

    /// Pure function: maps the three component states to the public
    /// `State`. Exposed at file-internal visibility so unit tests can
    /// drive the table directly without touching a real service.
    ///
    /// Decision order (top to bottom — earlier matches win):
    /// 1. Any backend-reported error → ERROR.
    /// 2. An unexpected runtime exit → ERROR.
    /// 3. A stop has been requested → STOPPED if the runtime is gone,
    ///    STOPPING otherwise.
    /// 4. Backend announced `stopping` → STOPPING.
    /// 5. Backend reached `ready` → STARTED.
    /// 6. Runtime is running OR backend reached `controlBound` → STARTING.
    /// 7. Otherwise → STOPPED.
    static func deriveState(
        nodeRuntime: NodeRuntimeState,
        backendState: BackendState,
        stopRequested: Bool
    ) -> State {
        if case .error = backendState { return .error }
        if case .exited(_, .unexpected) = nodeRuntime { return .error }

        if stopRequested {
            switch nodeRuntime {
            case .notRunning, .exited:
                return .stopped
            default:
                return .stopping
            }
        }
        if case .stopping = backendState { return .stopping }
        if case .ready = backendState { return .started }

        if case .running = nodeRuntime { return .starting }
        if case .controlBound = backendState { return .starting }

        return .stopped
    }

    /// Mutates one or more component-state fields under the lock,
    /// recomputes the derived `state`, and fires `onStateChange` outside
    /// the lock if the derived value changed.
    ///
    /// `error` is set when the transition has a caller-supplied error
    /// detail (most error paths). When the derived state lands in
    /// `.error` *without* a caller-supplied detail (e.g. an unexpected
    /// `nodeRuntime.exited`), a synthetic `ErrorInfo` is generated from
    /// the offending component so `getLastError()` is never silent on
    /// an ERROR.
    ///
    /// Callers must NOT hold `lock` — the callback runs outside the
    /// lock to prevent deadlock if an observer re-enters any locked
    /// method.
    ///
    /// **`mutate` discipline:** the closure runs while `lock` is held
    /// (NSLock is non-recursive). It must restrict itself to direct
    /// writes of the component-state fields — `nodeRuntime`,
    /// `backendState`, `stopRequested`, `_lastError`. It must NOT
    /// call any other locked method, fire `onStateChange`, recurse
    /// into `applyAndEmit`, or invoke arbitrary callbacks — any of
    /// those would deadlock.
    private func applyAndEmit(
        error: ErrorInfo? = nil,
        _ mutate: () -> Void
    ) {
        lock.lock()
        mutate()
        if let error = error {
            _lastError = error
        }
        let derived = NodeJSService.deriveState(
            nodeRuntime: nodeRuntime,
            backendState: backendState,
            stopRequested: stopRequested
        )
        let prev = state
        let enteringError = derived == .error && prev != .error
        state = derived

        // Synthesize a lastError if we're entering ERROR and the caller
        // didn't supply one. The backend-reported error path always
        // passes one in; the unexpected-runtime-exit path doesn't, so
        // we derive from the component state here.
        if enteringError && error == nil {
            if case .error(let phase, let message) = backendState {
                _lastError = ErrorInfo(phase: phase, message: message)
            } else if case .exited(let code, .unexpected) = nodeRuntime {
                _lastError = ErrorInfo(
                    phase: "node-runtime-unexpected",
                    message: "Node thread exited unexpectedly with code \(code)"
                )
            }
        }

        let leavingStarting = (prev == .starting && derived != .starting)
        let watchdog = leavingStarting ? startupWatchdog : nil
        if leavingStarting { startupWatchdog = nil }
        lock.unlock()

        // Snapshot + clear the boot transaction / phase spans on
        // `bootSentryQueue`. Concurrent terminal transitions
        // otherwise risk double-finishing: only the first thread
        // to observe `bootTransaction` non-nil drains; subsequent
        // ones see nil and skip. Bridge calls happen outside the
        // queue per the no-callbacks-under-sync discipline.
        let terminalStatus: String? = (prev != derived) ? {
            switch derived {
            case .started: return "ok"
            case .error: return "internal_error"
            case .stopping, .stopped: return "cancelled"
            case .starting: return nil
            }
        }() : nil
        var drainTx: Any?
        var drainSpans: [Any] = []
        if terminalStatus != nil {
            bootSentryQueue.sync {
                if let tx = self.bootTransaction {
                    drainTx = tx
                    drainSpans = Array(self.bootSpans.values)
                    self.bootTransaction = nil
                    self.bootSpans.removeAll()
                }
            }
        }

        // Cancel the watchdog outside the lock — `cancel()` doesn't
        // currently take any of our locks but the no-callbacks-under-lock
        // discipline holds for any future addition here.
        watchdog?.cancel()

        if prev != derived {
            logCrumb(
                category: SentryCategories.state,
                message: "\(prev.rawValue) → \(derived.rawValue)",
                level: derived == .error ? "error" : "info",
                data: ["from": prev.rawValue, "to": derived.rawValue]
            )
            if let status = terminalStatus, let tx = drainTx {
                for span in drainSpans {
                    SentryNativeBridge.finishSpan(span, status: status)
                }
                SentryNativeBridge.finishSpan(tx, status: status)
            }

            onStateChange?(derived)
        }
    }

    func start() {
        lock.lock()
        guard state == .stopped else {
            lock.unlock()
            log("Cannot start: already in state \(state.rawValue)")
            return
        }
        nodeCompletionSemaphore = DispatchSemaphore(value: 0)
        lock.unlock()

        // Open the boot transaction before applyAndEmit drives
        // STOPPED → STARTING; applyAndEmit's close-on-terminal
        // logic only fires when bootTransaction is non-nil.
        let tx = SentryNativeBridge.startBootTransaction()
        bootSentryQueue.sync { bootTransaction = tx }

        // Reset component state for a fresh start cycle and transition
        // STOPPED → STARTING via the derivation. `_lastError` is cleared
        // explicitly: today this only matters as defense-in-depth (the
        // `state == .stopped` guard above means fresh start is
        // reachable only from STOPPED, where `_lastError` is nil in
        // clean cycles) but it removes any chance of a stale ErrorInfo
        // leaking across start cycles if that invariant ever weakens.
        applyAndEmit {
            self.nodeRuntime = .running
            self.backendState = .unknown
            self.stopRequested = false
            self._lastError = nil
        }

        // Arm the startup watchdog. Captured `[weak self]` to avoid a
        // retain cycle holding the service alive past its natural
        // lifetime if the watchdog outlives the observer (it shouldn't,
        // but cheap insurance). Re-checks state under lock in case a
        // racing transition already left .starting between the timer
        // firing and us getting scheduled.
        let watchdog = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            self.lock.lock()
            let stillStarting = (self.state == .starting)
            self.lock.unlock()
            if stillStarting {
                let info = ErrorInfo(
                    phase: "starting-timeout",
                    message: "Service did not reach .started within \(Int(self.startupTimeout))s"
                )
                logCapture(
                    category: SentryCategories.state,
                    message: "comapeo: startup timeout fired",
                    level: "error",
                    tags: [
                        SentryTags.timeout: "startup",
                        SentryTags.phase: "starting-timeout",
                    ]
                )
                self.applyAndEmit(error: info) {
                    self.backendState = .error(phase: info.phase, message: info.message)
                }
            }
        }
        lock.lock()
        startupWatchdog = watchdog
        lock.unlock()
        DispatchQueue.global().asyncAfter(
            deadline: .now() + startupTimeout,
            execute: watchdog
        )

        deleteSocketFiles()

        // Initialize the control IPC connection (connects asynchronously,
        // waits for socket file). Drives the rootkey handshake: on `started`
        // we ship the init frame; on `ready` we transition to `.started`.
        // The backend's SimpleRpcServer replays both messages to late
        // clients, so even a slow connect is safe.
        controlIPC = NodeJSIPC(socketPath: controlSocketPath) { [weak self] message in
            self?.handleControlMessage(message)
        }

        // Start Node.js on a background thread
        let thread = Thread { [weak self] in
            self?.runNode()
        }
        thread.name = "com.comapeo.core.nodejs"
        thread.qualityOfService = .userInitiated
        thread.stackSize = 2 * 1024 * 1024 // 2MB stack required by nodejs-mobile
        nodeThread = thread
        thread.start()
    }

    /// Routes raw control-socket frames into component-state mutations.
    ///
    /// Frames are JSON of the shape `{"type":"<name>",…}` (well-known
    /// names: `started`, `ready`, `stopping`, `error`). We're already on
    /// the IPC's receive queue and the init-frame send dispatches async
    /// on the IPC's send queue, so a real parser costs nothing in
    /// latency or ordering and gains us forward-compat for additional
    /// fields.
    private func handleControlMessage(_ message: String) {
        switch ControlFrame.parse(message) {
        case .started:
            logCrumb(category: SentryCategories.control, message: "received: started")
            let nodeSpawnSpan = bootSentryQueue.sync {
                bootSpans.removeValue(forKey: "node-spawn")
            }
            if let span = nodeSpawnSpan {
                SentryNativeBridge.finishSpan(span, status: "ok")
            }
            applyAndEmit { self.backendState = .controlBound }
            sendInitFrame()
        case .ready:
            logCrumb(category: SentryCategories.control, message: "received: ready")
            // `ready` is the natural close point for the
            // `boot.init-frame` span opened in sendInitFrame().
            let initFrameSpan = bootSentryQueue.sync {
                bootSpans.removeValue(forKey: "init-frame")
            }
            if let span = initFrameSpan {
                SentryNativeBridge.finishSpan(span, status: "ok")
            }
            applyAndEmit { self.backendState = .ready }
        case .stopping:
            logCrumb(category: SentryCategories.control, message: "received: stopping")
            // Backend is gracefully shutting down. The next thing we'll
            // see is the socket close; the derivation maps this to
            // STOPPING, and the subsequent runtime exit will derive to
            // STOPPED (via `.exited(_, .requested)`).
            applyAndEmit { self.backendState = .stopping }
        case .error(let phase, let message):
            logCrumb(
                category: SentryCategories.control,
                message: "received: error",
                level: "error",
                data: ["phase": phase, "message": message]
            )
            let info = ErrorInfo(phase: phase, message: message)
            applyAndEmit(error: info) {
                self.backendState = .error(phase: phase, message: message)
            }
        case .sentryEvent(let payloadJson):
            SentryNativeBridge.captureEventJson(payloadJson)
        case .sentryEnvelope(let data):
            SentryNativeBridge.captureEnvelopeBase64(data)
        case .malformed(let detail):
            // Forwarded via `onMessageError` (the JS bridge wires it
            // to the `messageerror` event). Not raised to `.error`:
            // a single bad frame shouldn't take down a session.
            logCrumb(
                category: SentryCategories.control,
                message: "malformed control frame",
                level: "warning",
                data: ["detail": detail]
            )
            onMessageError?(detail)
        }
    }

    /// Reads the rootkey, base64-encodes, and ships the init frame on the
    /// control socket. Called exactly once per start cycle, in response to
    /// the backend's `started` broadcast.
    ///
    /// Failures transition to `.error` via `backendState = .error(...)`
    /// and capture the cause. We deliberately do **not** tear down the
    /// node thread here: `.error` is observable by the application (via
    /// the JS `stateChange` event), and recovery — calling
    /// `stop()`+`cleanup()` then re-creating the service, prompting the
    /// user, etc. — is the application's responsibility. Tearing down
    /// inside this layer would race with the application's own ERROR
    /// observation.
    ///
    /// See the `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` note in
    /// `RootKeyStore`: a device that has never been unlocked since reboot
    /// will throw here. The application can re-attempt by tearing down
    /// the service and creating a new one once the device is unlocked.
    private func sendInitFrame() {
        guard let ipc = controlIPC else { return }
        // `boot.rootkey-load` span: closed `ok` after a successful
        // load, `internal_error` after the catch.
        let txForRootkey = bootSentryQueue.sync { bootTransaction }
        let rootkeySpan = SentryNativeBridge.startBootSpan(txForRootkey, phase: "rootkey-load")
        var keyBytes: Data
        do {
            let result = try rootKeyProvider()
            keyBytes = result.key
            if let span = rootkeySpan {
                SentryNativeBridge.setSpanData(span, key: "generated", value: result.generated)
                SentryNativeBridge.finishSpan(span, status: "ok")
            }
        } catch {
            if let span = rootkeySpan {
                SentryNativeBridge.finishSpan(span, status: "internal_error")
            }
            // Lands on the same scope as the JS adapter's capture;
            // Sentry fingerprinting de-dupes the JS-adapter capture
            // that lands on the same scope. The phase tag splits
            // rootkey errors from other ERROR causes.
            logException(
                category: SentryCategories.boot,
                error: error,
                message: "Failed to load rootkey",
                tags: [
                    SentryTags.phase: "rootkey",
                    SentryTags.state: "ERROR",
                    SentryTags.source: "rootkey-store",
                ]
            )
            let info = ErrorInfo(phase: "rootkey", message: error.localizedDescription)
            applyAndEmit(error: info) {
                self.backendState = .error(phase: info.phase, message: info.message)
            }
            return
        }
        defer {
            // Best-effort zeroing. Swift `Data` doesn't guarantee single
            // ownership of its backing buffer, so this is a hygiene measure
            // not a security guarantee.
            keyBytes.withUnsafeMutableBytes { rawBuf in
                if let base = rawBuf.baseAddress {
                    memset(base, 0, rawBuf.count)
                }
            }
        }
        let b64 = keyBytes.base64EncodedString()
        let frame = "{\"type\":\"init\",\"rootKey\":\"\(b64)\"}"
        // `boot.init-frame` span: from "init sent" to "ready
        // received" (closed in handleControlMessage).
        let txForInitFrame = bootSentryQueue.sync { bootTransaction }
        if let span = SentryNativeBridge.startBootSpan(txForInitFrame, phase: "init-frame") {
            bootSentryQueue.sync { bootSpans["init-frame"] = span }
        }
        ipc.sendMessage(frame)
        logCrumb(category: SentryCategories.boot, message: "init frame sent")
    }

    /// Gracefully stops the Node.js process by sending a shutdown message.
    ///
    /// - Parameter timeout: Maximum time to wait for graceful shutdown (default: 10 seconds).
    func stop(timeout: TimeInterval = 10) {
        lock.lock()
        guard state == .started || state == .starting else {
            lock.unlock()
            log("Cannot stop: state is \(state.rawValue)")
            return
        }
        let completionSem = nodeCompletionSemaphore
        lock.unlock()

        // Mark intent — this drives the derivation toward STOPPING and
        // (once the runtime exits) STOPPED.
        applyAndEmit { self.stopRequested = true }

        // Send shutdown message — this causes Node.js JS code to exit,
        // which unblocks node_start() in runNode().
        //
        // If controlIPC is still in .connecting (Node hasn't started listening on
        // control.sock yet), sendMessageSync enqueues the message in IPC's
        // pendingMessages list. cleanup() then calls controlIPC.disconnect(), which
        // discards pending messages without flushing them. The message is lost,
        // the semaphore wait below times out, and the service transitions to .error.
        // This is intentional: if Node hasn't connected within `timeout` seconds,
        // there's nothing we can do but declare the shutdown failed.
        let shutdownMessage = "{\"type\":\"shutdown\"}"
        if let ipc = controlIPC {
            ipc.sendMessageSync(shutdownMessage)
            logCrumb(category: SentryCategories.state, message: "shutdown frame sent")
        }

        // Wait for node thread to complete (node_start blocks until exit)
        let result = completionSem?.wait(timeout: .now() + timeout)
        let threadExited = (result != .timedOut)
        if !threadExited {
            logCrumb(
                category: SentryCategories.state,
                message: "graceful shutdown timed out after \(timeout)s",
                level: "warning"
            )
        }

        cleanup(threadExited: threadExited)
    }

    private func runNode() {
        guard let jsPath = resolveJSEntryPoint() else {
            lock.lock()
            let sem = nodeCompletionSemaphore
            lock.unlock()
            let info = ErrorInfo(
                phase: "node-runtime",
                message: "Could not find nodejs-project/loader.mjs in app bundle"
            )
            // Mark the runtime as exited alongside the backend-error so
            // the component triple is consistent — without this the
            // thread is exiting (we're about to return + signal the
            // semaphore) but `nodeRuntime` would still say `.running`.
            // Reason `.requested` anchors the derivation on the explicit
            // backend error rather than competing with rule 2.
            applyAndEmit(error: info) {
                self.backendState = .error(phase: info.phase, message: info.message)
                self.nodeRuntime = .exited(code: -1, reason: .requested)
            }
            sem?.signal()
            return
        }

        lock.lock()
        let completionSem = nodeCompletionSemaphore
        lock.unlock()
        // Stay in `.starting` while Node spins up — the transition to
        // `.started` waits for the backend's `ready` broadcast (after
        // ComapeoManager is constructed), driven by `handleControlMessage`.

        // argv shape matches Android's NodeJSService.kt:
        //   [node, --no-experimental-fetch, loaderPath, comapeoSocketPath,
        //    controlSocketPath, privateStorageDir, ...sentryFlags]
        //
        // `--no-experimental-fetch` disables Node's built-in `globalThis.fetch`
        // (and thus the lazy-loaded undici under it). nodejs-mobile iOS runs
        // V8 with `--jitless` for App Store compliance, which suppresses the
        // `WebAssembly` global; undici's HTTP/1.1 client calls
        // `WebAssembly.compile` at module-init and crashes the process. The
        // bundled backend already strips its only direct undici user (the
        // maps fastify plugin); this flag prevents anything that calls the
        // global `fetch` from re-introducing the same load path. Android
        // doesn't need it (JIT is permitted), but the flag is harmless on
        // both platforms so we keep argv parity.
        // Open boot.node-spawn (stage B) BEFORE buildSentryArgs so
        // the trace flag forwards node-spawn's span ID; that makes
        // Node-side spans (loader-init, import-index, listen-control)
        // children of node-spawn rather than the transaction. Closed
        // in handleControlMessage on the `started` frame.
        let nodeSpawnSpan = bootSentryQueue.sync { bootTransaction }
            .flatMap { SentryNativeBridge.startBootSpan($0, phase: "node-spawn") }
        if let span = nodeSpawnSpan {
            bootSentryQueue.sync { bootSpans["node-spawn"] = span }
        }
        var args: [String] = [
            "node",
            "--no-experimental-fetch",
            jsPath,
            comapeoSocketPath,
            controlSocketPath,
            privateStorageDir,
        ]
        args.append(contentsOf: buildSentryArgs())
        let exitCode = nodeEntryPoint(args)
        logCrumb(
            category: SentryCategories.boot,
            message: "node thread exited",
            level: exitCode == 0 ? "info" : "warning",
            data: ["exitCode": exitCode]
        )

        // Classify the exit. "Requested" means we asked for it (stop()
        // was called) or the backend announced it (`stopping` frame
        // landed before exit). Anything else is unexpected — a crash
        // in a native addon, a `process.abort()` we didn't see coming,
        // a SIGSEGV — and derives to ERROR with a synthesized phase.
        applyAndEmit {
            let isRequested: Bool
            if self.stopRequested {
                isRequested = true
            } else if case .stopping = self.backendState {
                isRequested = true
            } else if case .error = self.backendState {
                // An error frame already arrived; treat the exit as
                // matching that error (the derivation keeps ERROR via
                // backendState anyway). Reason here is bookkeeping only.
                isRequested = true
            } else {
                isRequested = false
            }
            self.nodeRuntime = .exited(
                code: exitCode,
                reason: isRequested ? .requested : .unexpected
            )
        }

        // Signal that the node thread has finished
        completionSem?.signal()
    }

    /// Releases IPC and socket-file resources.
    ///
    /// - Parameter threadExited: Whether the node runtime thread has actually
    ///   exited. When `false` (e.g. a timed-out graceful shutdown or a
    ///   background-task expiration that cut the wait short), the node
    ///   thread is still alive; the service transitions to `.error` so
    ///   `start()` cannot be called again and violate the once-per-process
    ///   constraint of `NodeMobileStartNode`. When `true`, the service is
    ///   fully stopped and transitions to `.stopped`.
    /// Flags consumed by `backend/loader.mjs`.
    private func buildSentryArgs() -> [String] {
        guard let cfg = sentryConfig else { return [] }
        var out: [String] = [
            "--sentryDsn=\(cfg.dsn)",
            "--sentryEnvironment=\(cfg.environment)",
            "--sentryRelease=\(cfg.release)",
        ]
        if let r = cfg.sampleRate {
            out.append("--sentrySampleRate=\(r)")
        }
        if let r = cfg.tracesSampleRate {
            out.append("--sentryTracesSampleRate=\(r)")
        }
        if let b = cfg.rpcArgsBytes {
            out.append("--sentryRpcArgsBytes=\(b)")
        }
        if cfg.enableLogs == true {
            out.append("--sentryEnableLogs")
        }
        // captureApplicationData (Phase 5) wires up via SentryPrefsStore.

        // Prefer the node-spawn span over the transaction so Node-side
        // boot spans nest under it. Falls back to the transaction when
        // node-spawn isn't open yet.
        let traceParent: Any? = bootSentryQueue.sync {
            bootSpans["node-spawn"] ?? bootTransaction
        }
        if let trace = SentryNativeBridge.getTraceData(traceParent)?.trace {
            out.append("--sentryTrace=\(trace)")
        }
        return out
    }

    func cleanup(threadExited: Bool = true) {
        controlIPC?.disconnect()
        controlIPC = nil
        deleteSocketFiles()

        lock.lock()
        // Signal in case cleanup is called directly (e.g., from background task expiration)
        nodeCompletionSemaphore?.signal()
        nodeCompletionSemaphore = nil
        nodeThread = nil
        lock.unlock()

        if threadExited {
            // `threadExited: true` is the caller asserting the runtime
            // has finished (via stop(), or because the application is
            // tearing down deliberately). Per the documented contract,
            // this always lands in .stopped — including from .error,
            // since cleanup-from-error is the recovery path after which
            // the application is expected to create a fresh instance.
            // We force the three component states that the derivation
            // reads, but leave `_lastError` intact so a caller that
            // observed ERROR can still read getLastError() after
            // cleanup() to decide what to do next.
            applyAndEmit {
                self.stopRequested = true
                self.nodeRuntime = .exited(code: 0, reason: .requested)
                // Drop a backend-side .error / .stopping / .ready /
                // .controlBound: those drove the previous derivation,
                // we now want a clean .stopped.
                self.backendState = .unknown
            }
        } else {
            logCapture(
                category: SentryCategories.state,
                message: "comapeo: stop timeout fired",
                level: "error",
                tags: [
                    SentryTags.timeout: "shutdown",
                    SentryTags.phase: "shutdown-timeout",
                ]
            )
            let info = ErrorInfo(
                phase: "shutdown-timeout",
                message: "Graceful shutdown timed out — node thread still alive"
            )
            applyAndEmit(error: info) {
                self.backendState = .error(phase: info.phase, message: info.message)
            }
        }
    }

    private func deleteSocketFiles() {
        let fm = FileManager.default
        try? fm.removeItem(atPath: comapeoSocketPath)
        try? fm.removeItem(atPath: controlSocketPath)
    }

}
