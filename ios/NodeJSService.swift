import Foundation

/// Result returned by ``NodeJSService/RootKeyProvider``. File-scope so
/// it's visible from the SPM target (which excludes `RootKeyStore.swift`
/// — Keychain APIs aren't available on macOS) and the production
/// CocoaPods build (which globs all top-level `*.swift`).
struct RootKeyResult {
    let key: Data
    let generated: Bool
}

/// Manages the lifecycle of an embedded Node.js process on iOS.
///
/// Unlike Android (which uses a foreground service in a separate
/// process), iOS runs Node.js in-process. Graceful shutdown is
/// triggered on `applicationWillTerminate`.
///
/// The public `state` is *derived* from three component fields —
/// `nodeRuntime`, `backendState`, `stopRequested` — via `deriveState`.
/// This makes "node exits without a control frame" deterministically
/// observable: the derivation produces `.error` and `_lastError`
/// carries which component caused it.
class NodeJSService {
    /// Lifecycle states. Mirrors Android's `NodeJSService.State` 1:1.
    ///
    /// `.error` is per-instance terminal. `start()`/`stop()` are
    /// refused; the only way out is `cleanup()` then a fresh
    /// `NodeJSService`. The node thread may still be alive when
    /// `.error` is set — this layer doesn't tear it down; `cleanup()`
    /// does.
    enum State: String {
        case stopped = "STOPPED"
        case starting = "STARTING"
        case started = "STARTED"
        case stopping = "STOPPING"
        case error = "ERROR"
    }

    /// Detail attached to `.error` transitions. `phase` mirrors backend
    /// phase strings (`listen-control`, `init`, `construct`, `runtime`)
    /// plus local ones (`rootkey`, `starting-timeout`, `shutdown-timeout`,
    /// `node-runtime-unexpected`, `node-runtime`).
    struct ErrorInfo: Equatable {
        let phase: String
        let message: String
    }

    // MARK: - Component state (derivation inputs)

    /// `exited.reason` distinguishes a graceful exit (we asked via `stop()`
    /// or saw a `stopping` frame) from an unexpected one — the latter
    /// derives to `.error`, so a native-addon crash or unrecoverable
    /// `process.abort()` surfaces as ERROR rather than STOPPED.
    enum NodeRuntimeState: Equatable {
        case notRunning
        case running
        case exited(code: Int32, reason: ExitReason)
    }

    enum ExitReason: Equatable {
        case requested
        case unexpected
    }

    /// Backend state reported via control-socket frames, plus the local
    /// failure slot (rootkey load, watchdog timeout). `unknown` = "no
    /// frames yet"; `controlBound` = "received `started`, awaiting ready".
    enum BackendState: Equatable {
        case unknown
        case controlBound
        case ready
        case stopping
        case error(phase: String, message: String)
    }

    /// Blocking function that runs Node.js. Returns the exit code.
    typealias NodeEntryPoint = (_ arguments: [String]) -> Int32

    /// Returns the 16-byte rootkey + `generated` flag (true on first
    /// install). Called once per `start()`, off the main thread, after
    /// the backend's `started` broadcast.
    typealias RootKeyProvider = () throws -> RootKeyResult

    static let comapeoSocketFilename = "comapeo.sock"
    static let controlSocketFilename = "control.sock"

    private let socketDir: String
    /// Backend's third argv positional. Mirrors Android's `dataDir`. The
    /// embedded ComapeoManager opens SQLite/blobs under here, so it must
    /// be writable, app-private, and survive process restarts.
    private let privateStorageDir: String
    let comapeoSocketPath: String
    let controlSocketPath: String
    private var controlIPC: NodeJSIPC?
    private var nodeThread: Thread?
    private let lock = NSLock()

    private var nodeCompletionSemaphore: DispatchSemaphore?

    private let nodeEntryPoint: NodeEntryPoint
    private let resolveJSEntryPoint: () -> String?
    /// Resolves the optional default project config the consuming app
    /// bundles via the Expo plugin. `nil` → new projects get no default
    /// config (backend receives an empty positional).
    private let resolveDefaultConfigPath: () -> String?
    private let rootKeyProvider: RootKeyProvider

    /// Maximum time in `.starting` before the watchdog forces `.error`.
    /// Without it, a backend hang would leave `.starting` as a black hole.
    private let startupTimeout: TimeInterval

    /// Set in `start()`, cancelled by `applyAndEmit` when leaving
    /// `.starting`. Stored under `lock`.
    private var startupWatchdog: DispatchWorkItem?

    /// Sentry boot transaction handle. Opened in `start()`, drained by
    /// `applyAndEmit` on the first terminal transition. `Any?` keeps
    /// Sentry types out of this file's signatures.
    ///
    /// Every read/write of `bootTransaction` and `bootSpans` goes through
    /// `bootSentryQueue.sync`; bridge calls happen outside the queue
    /// (no-callbacks-under-sync, same as `lock`).
    fileprivate var bootTransaction: Any?
    fileprivate var bootSpans: [String: Any] = [:]
    fileprivate let bootSentryQueue = DispatchQueue(
        label: "com.comapeo.core.bootSentry"
    )

    var onStateChange: ((State) -> Void)?

    /// Fires for control-socket frames the receiver can't process
    /// (non-JSON, unknown / empty `type`). Mirrors DOM `MessagePort`'s
    /// `messageerror`: malformed frames don't transition to `.error`.
    var onMessageError: ((String) -> Void)?

    /// Cached derivation of the public lifecycle state. Recomputed by
    /// `applyAndEmit`; stored so external readers get lock-free O(1) access.
    private(set) var state: State = .stopped

    // Component state — mutated only under `lock`.
    private var nodeRuntime: NodeRuntimeState = .notRunning
    private var backendState: BackendState = .unknown
    private var stopRequested: Bool = false

    /// Last `.error` detail. Set by `applyAndEmit`; read via
    /// `getLastError()` (lock-guarded).
    private var _lastError: ErrorInfo?

    func getLastError() -> ErrorInfo? {
        lock.lock()
        defer { lock.unlock() }
        return _lastError
    }

    /// Forwarded as `--sentry*` argv to `backend/loader.mjs`.
    /// `nil` → loader skips Sentry.
    private let sentryConfig: SentryConfig?
    private let applicationUsageData: Bool
    private let debug: Bool
    private let deviceTags: DeviceTags?
    /// Derived Sentry user.id (monthly/permanent hash) forwarded as `--sentryUserId`.
    private let sentryUserId: String?

    init(
        socketDir: String,
        privateStorageDir: String,
        nodeEntryPoint: @escaping NodeEntryPoint,
        resolveJSEntryPoint: @escaping () -> String?,
        resolveDefaultConfigPath: @escaping () -> String? = {
            Bundle.main.path(forResource: "comapeo-default-config", ofType: "comapeocat")
        },
        rootKeyProvider: @escaping RootKeyProvider,
        sentryConfig: SentryConfig? = SentryConfig.loadFromMainBundle(),
        applicationUsageData: Bool = false,
        debug: Bool = false,
        deviceTags: DeviceTags? = nil,
        sentryUserId: String? = nil,
        startupTimeout: TimeInterval = 30
    ) {
        self.socketDir = socketDir
        self.privateStorageDir = privateStorageDir
        self.sentryConfig = sentryConfig
        self.applicationUsageData = applicationUsageData
        self.debug = debug
        self.deviceTags = deviceTags
        self.sentryUserId = sentryUserId
        self.comapeoSocketPath = (socketDir as NSString).appendingPathComponent(NodeJSService.comapeoSocketFilename)
        self.controlSocketPath = (socketDir as NSString).appendingPathComponent(NodeJSService.controlSocketFilename)

        // sockaddr_un.sun_path is 104 bytes on Darwin (incl. null terminator).
        // Silent truncation makes bind() succeed against a different file.
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
        self.resolveDefaultConfigPath = resolveDefaultConfigPath
        self.rootKeyProvider = rootKeyProvider
        self.startupTimeout = startupTimeout

        try? FileManager.default.createDirectory(atPath: socketDir, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(atPath: privateStorageDir, withIntermediateDirectories: true)
        deleteSocketFiles()
    }

    // MARK: - Derivation

    /// Pure function: maps the three component states to the public
    /// `State`. Decision order (earlier matches win):
    /// 1. Backend-reported error → ERROR.
    /// 2. Unexpected runtime exit → ERROR.
    /// 3. Stop requested → STOPPED if runtime is gone, else STOPPING.
    /// 4. Backend `stopping` → STOPPING.
    /// 5. Backend `ready` → STARTED.
    /// 6. Runtime running OR backend `controlBound` → STARTING.
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

    /// Mutates component-state fields under `lock`, recomputes derived
    /// `state`, and fires `onStateChange` outside the lock.
    ///
    /// `error` carries caller-supplied detail on most error paths; when
    /// the derivation lands in `.error` *without* one (e.g. unexpected
    /// runtime exit), a synthetic `ErrorInfo` is generated so
    /// `getLastError()` is never silent on ERROR.
    ///
    /// `mutate` runs while `lock` is held (NSLock is non-recursive). It
    /// must only do direct writes to `nodeRuntime`/`backendState`/
    /// `stopRequested`/`_lastError` — no locked methods, no callbacks,
    /// no recursion into `applyAndEmit` (would deadlock). Callers must
    /// not hold `lock`.
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

        // Synthesize when entering ERROR without caller-supplied detail
        // (the unexpected-runtime-exit path).
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

        // Drain boot transaction / phase spans on `bootSentryQueue`.
        // Concurrent terminal transitions otherwise risk double-finishing;
        // only the first thread to see `bootTransaction` non-nil drains.
        let terminalStatus: SpanStatus? = (prev != derived) ? {
            switch derived {
            case .started: return .ok
            case .error: return .internalError
            case .stopping, .stopped: return .cancelled
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

        watchdog?.cancel()

        if prev != derived {
            logCrumb(
                category: SentryCategories.state,
                message: "\(prev.rawValue) → \(derived.rawValue)",
                level: derived == .error ? .error : .info,
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

        // Open the boot transaction before STOPPED → STARTING;
        // `applyAndEmit`'s close-on-terminal only fires when non-nil.
        let tx = SentryNativeBridge.startBootTransaction()
        bootSentryQueue.sync { bootTransaction = tx }

        // Reset component state for a fresh start cycle. `_lastError`
        // clear is defence-in-depth — the `.stopped` guard above means
        // fresh start is reachable only from STOPPED where it's nil.
        applyAndEmit {
            self.nodeRuntime = .running
            self.backendState = .unknown
            self.stopRequested = false
            self._lastError = nil
        }

        // Arm the startup watchdog. Re-checks state under lock — a
        // transition out of .starting may have raced the timer.
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
                    level: .error,
                    tags: [
                        SentryTags.timeout: "startup",
                        SentryTags.phase: "starting-timeout",
                    ]
                )
                self.sendErrorNativeFrame(phase: info.phase, message: info.message)
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

        // The backend's SimpleRpcServer replays `started`/`ready` to late
        // clients, so a slow connect here is safe.
        controlIPC = NodeJSIPC(socketPath: controlSocketPath) { [weak self] message in
            self?.handleControlMessage(message)
        }

        let thread = Thread { [weak self] in
            self?.runNode()
        }
        thread.name = "com.comapeo.core.nodejs"
        thread.qualityOfService = .userInitiated
        thread.stackSize = 2 * 1024 * 1024 // nodejs-mobile requires 2MB
        nodeThread = thread
        thread.start()
    }

    /// Routes parsed control-socket frames into component-state mutations.
    private func handleControlMessage(_ message: String) {
        switch ControlFrame.parse(message) {
        case .started:
            logCrumb(category: SentryCategories.control, message: "received: started")
            let nodeSpawnSpan = bootSentryQueue.sync {
                bootSpans.removeValue(forKey: "node-spawn")
            }
            if let span = nodeSpawnSpan {
                SentryNativeBridge.finishSpan(span, status: .ok)
            }
            applyAndEmit { self.backendState = .controlBound }
            sendInitFrame()
        case .ready:
            logCrumb(category: SentryCategories.control, message: "received: ready")
            applyAndEmit { self.backendState = .ready }
        case .stopping:
            logCrumb(category: SentryCategories.control, message: "received: stopping")
            applyAndEmit { self.backendState = .stopping }
        case .error(let phase, let message):
            logCrumb(
                category: SentryCategories.control,
                message: "received: error",
                level: .error,
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
            // Forwarded via `onMessageError`. Not raised to `.error` —
            // a single bad frame shouldn't take down a session.
            logCrumb(
                category: SentryCategories.control,
                message: "malformed control frame",
                level: .warning,
                data: ["detail": detail]
            )
            onMessageError?(detail)
        }
    }

    /// Loads the rootkey and ships the init frame on the control socket.
    /// Called once per start cycle, on the backend's `started` broadcast.
    ///
    /// Failures transition to `.error` and forward `error-native` to
    /// Node so the backend's `handleFatal` exits the runtime — without
    /// it, the Node thread would stay parked on `await initPromise`
    /// indefinitely (parallel of the Android FGS pattern, in-process
    /// here). `.error` is observable via `stateChange`; recovery
    /// (`stop()` + `cleanup()` + fresh service) is the application's call.
    /// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` means a device
    /// not unlocked since reboot throws here; retry once unlocked.
    private func sendInitFrame() {
        guard let ipc = controlIPC else { return }
        let txForRootkey = bootSentryQueue.sync { bootTransaction }
        let rootkeySpan = SentryNativeBridge.startBootSpan(txForRootkey, phase: "rootkey-load")
        var keyBytes: Data
        do {
            let result = try rootKeyProvider()
            keyBytes = result.key
            if let span = rootkeySpan {
                SentryNativeBridge.setSpanData(span, key: "generated", value: result.generated)
                SentryNativeBridge.finishSpan(span, status: .ok)
            }
        } catch {
            if let span = rootkeySpan {
                SentryNativeBridge.finishSpan(span, status: .internalError)
            }
            // Same scope as the JS adapter's capture — Sentry
            // fingerprinting de-dupes; the phase tag splits this from
            // other ERROR causes.
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
            sendErrorNativeFrame(phase: info.phase, message: info.message)
            applyAndEmit(error: info) {
                self.backendState = .error(phase: info.phase, message: info.message)
            }
            return
        }
        defer {
            // Best-effort zeroing. `Data` doesn't guarantee single
            // ownership of its buffer, so this is hygiene, not security.
            keyBytes.withUnsafeMutableBytes { rawBuf in
                if let base = rawBuf.baseAddress {
                    memset(base, 0, rawBuf.count)
                }
            }
        }
        let b64 = keyBytes.base64EncodedString()
        let frame = "{\"type\":\"init\",\"rootKey\":\"\(b64)\"}"
        ipc.sendMessage(frame)
        logCrumb(category: SentryCategories.boot, message: "init frame sent")
    }

    /// Sends `{type:"error-native",phase,message}` to Node on the
    /// control socket. The backend's `error-native` handler routes
    /// through `handleFatal`, which broadcasts an `error` frame to all
    /// clients and exits 1 — cleanly tearing down the Node thread that
    /// would otherwise stay parked on `await initPromise` after a
    /// native-side rootkey or watchdog failure. Mirror of the Android
    /// FGS-side back-channel (single-process here, so the value is
    /// reclaiming the leaked Node thread + control-socket binding
    /// rather than cross-process attribution).
    ///
    /// Best-effort: `NodeJSIPC.sendMessage` queues into `pendingMessages`
    /// if the socket isn't connected yet, so a watchdog firing before
    /// the backend has bound just no-ops on the frame (Node will exit
    /// when the thread is reaped at app termination anyway).
    private func sendErrorNativeFrame(phase: String, message: String) {
        guard let ipc = controlIPC else { return }
        let payload: [String: Any] = [
            "type": "error-native",
            "phase": phase,
            "message": message,
        ]
        guard
            let data = try? JSONSerialization.data(withJSONObject: payload),
            let json = String(data: data, encoding: .utf8)
        else {
            log("Failed to serialize error-native frame (phase=\(phase))")
            return
        }
        ipc.sendMessage(json)
        log("Sent error-native frame to backend (phase=\(phase))")
    }

    /// Gracefully stops Node.js. `timeout` bounds the wait for the
    /// thread to exit; on timeout the service lands in `.error`.
    func stop(timeout: TimeInterval = 10) {
        lock.lock()
        guard state == .started || state == .starting else {
            lock.unlock()
            log("Cannot stop: state is \(state.rawValue)")
            return
        }
        let completionSem = nodeCompletionSemaphore
        lock.unlock()

        applyAndEmit { self.stopRequested = true }

        // If controlIPC is still .connecting, sendMessageSync queues into
        // pendingMessages; cleanup() then disconnects without flushing,
        // the semaphore times out, and we land in .error. Intentional —
        // if Node hasn't connected within `timeout`, shutdown has failed.
        let shutdownMessage = "{\"type\":\"shutdown\"}"
        if let ipc = controlIPC {
            ipc.sendMessageSync(shutdownMessage)
            logCrumb(category: SentryCategories.state, message: "shutdown frame sent")
        }

        let result = completionSem?.wait(timeout: .now() + timeout)
        let threadExited = (result != .timedOut)
        if !threadExited {
            logCrumb(
                category: SentryCategories.state,
                message: "graceful shutdown timed out after \(timeout)s",
                level: .warning
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
            // Mark runtime exited alongside the backend-error so the
            // component triple is consistent. `.requested` anchors the
            // derivation on the backend error (rule 1) rather than rule 2.
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

        // argv mirrors Android. `--no-experimental-fetch` disables Node's
        // built-in fetch + lazy undici: nodejs-mobile iOS runs V8 with
        // `--jitless` (App Store), which kills WebAssembly; undici's HTTP/1
        // client calls `WebAssembly.compile` at module init and crashes
        // the process. Android keeps the flag for argv parity.
        //
        // Open boot.node-spawn BEFORE buildSentryArgs so the trace flag
        // forwards node-spawn's span ID — Node-side spans then nest
        // under it rather than the transaction. Closed by
        // `handleControlMessage` on the `started` frame.
        let nodeSpawnSpan = bootSentryQueue.sync { bootTransaction }
            .flatMap { SentryNativeBridge.startBootSpan($0, phase: "node-spawn") }
        if let span = nodeSpawnSpan {
            bootSentryQueue.sync { bootSpans["node-spawn"] = span }
        }
        // 4th positional: default config path, or "" when the app bundled
        // none. Always present so the `--sentry*` flags can't slip into it.
        let defaultConfigPath = resolveDefaultConfigPath() ?? ""
        // 5th positional: consumer's online map style URL, or "" when unset.
        let defaultOnlineStyleUrl = resolveDefaultOnlineStyleUrl() ?? ""
        var args: [String] = ["node", "--no-experimental-fetch"]
        // Debug builds ship the backend's `.map` next to the bundle via the
        // Debug-only `ComapeoCoreSourcemaps` companion pod. `--enable-source-maps`
        // (a Node runtime flag, so it precedes the script path) makes Node
        // remap stacks to original positions in-process, so Sentry events
        // are symbolicated without a map upload. Release omits it and relies
        // on consumer-uploaded maps (debug-ID matched, symbolicated by Sentry).
        #if DEBUG
        args.append("--enable-source-maps")
        #endif
        args.append(contentsOf: [
            jsPath,
            comapeoSocketPath,
            controlSocketPath,
            privateStorageDir,
            defaultConfigPath,
            defaultOnlineStyleUrl,
        ])
        args.append(contentsOf: buildSentryArgs())
        let exitCode = nodeEntryPoint(args)
        logCrumb(
            category: SentryCategories.boot,
            message: "node thread exited",
            level: exitCode == 0 ? .info : .warning,
            data: ["exitCode": exitCode]
        )

        // Classify the exit. Unexpected = no preceding stop signal or
        // error frame; derives to ERROR via `.exited(_, .unexpected)`.
        applyAndEmit {
            let isRequested: Bool
            if self.stopRequested {
                isRequested = true
            } else if case .stopping = self.backendState {
                isRequested = true
            } else if case .error = self.backendState {
                isRequested = true
            } else {
                isRequested = false
            }
            self.nodeRuntime = .exited(
                code: exitCode,
                reason: isRequested ? .requested : .unexpected
            )
        }

        completionSem?.signal()
    }

    /// Info.plist key written by `app.plugin.js` when the consumer sets
    /// `defaultOnlineStyleUrl`. Must stay in sync with the plugin's
    /// `IOS_MAP_STYLE_URL_KEY`.
    static let defaultOnlineStyleUrlPlistKey = "ComapeoCoreDefaultOnlineStyleUrl"

    /// Consumer's online map style URL from Info.plist, or nil when unset.
    private func resolveDefaultOnlineStyleUrl() -> String? {
        let value = Bundle.main.object(
            forInfoDictionaryKey: NodeJSService.defaultOnlineStyleUrlPlistKey
        ) as? String
        return value?.isEmpty == false ? value : nil
    }

    /// `--sentry*` argv flags consumed by `backend/loader.mjs`. Empty
    /// when `sentryConfig` is nil (Sentry off).
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
        // Native owns the trace-sampling decision: full while the debug window
        // is on, else the plugin-configured cap (0 if unset). The backend
        // mirrors this value rather than re-deciding.
        let effectiveTracesSampleRate = debug ? 1.0 : (cfg.tracesSampleRate ?? 0.0)
        out.append("--sentryTracesSampleRate=\(effectiveTracesSampleRate)")
        if let b = cfg.rpcArgsBytes {
            out.append("--sentryRpcArgsBytes=\(b)")
        }
        if cfg.enableLogs == true {
            out.append("--sentryEnableLogs")
        }
        if let userId = sentryUserId {
            out.append("--sentryUserId=\(userId)")
        }
        if applicationUsageData {
            out.append("--applicationUsageData")
        }
        if debug {
            out.append("--debug")
        }
        if let tags = deviceTags {
            out.append("--deviceClass=\(tags.deviceClass)")
            out.append("--osMajor=\(tags.osMajor)")
            out.append("--platformTag=\(tags.platform)")
        }

        // Prefer the node-spawn span over the transaction so Node-side
        // boot spans nest under it.
        let traceParent: Any? = bootSentryQueue.sync {
            bootSpans["node-spawn"] ?? bootTransaction
        }
        if let trace = SentryNativeBridge.getTraceData(traceParent)?.trace {
            out.append("--sentryTrace=\(trace)")
        }
        return out
    }

    /// Releases IPC and socket-file resources. `threadExited: false`
    /// means the node thread is still alive (timed-out shutdown); the
    /// service then lands in `.error` so `start()` cannot violate
    /// `NodeMobileStartNode`'s once-per-process constraint. `true` lands
    /// in `.stopped`.
    func cleanup(threadExited: Bool = true) {
        controlIPC?.disconnect()
        controlIPC = nil
        deleteSocketFiles()

        lock.lock()
        // Signal in case cleanup is called directly (background expiration).
        nodeCompletionSemaphore?.signal()
        nodeCompletionSemaphore = nil
        nodeThread = nil
        lock.unlock()

        if threadExited {
            // Always lands in `.stopped`, including from `.error` —
            // cleanup-from-error is the recovery path. `_lastError` is
            // left intact so `getLastError()` stays readable.
            applyAndEmit {
                self.stopRequested = true
                self.nodeRuntime = .exited(code: 0, reason: .requested)
                self.backendState = .unknown
            }
        } else {
            logCapture(
                category: SentryCategories.state,
                message: "comapeo: stop timeout fired",
                level: .error,
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
