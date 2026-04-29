import Foundation

/// Manages the lifecycle of an embedded Node.js process on iOS.
///
/// Unlike Android (which uses a foreground service in a separate process), iOS runs
/// Node.js in-process. Graceful shutdown is triggered when the app is about to be
/// terminated (`applicationWillTerminate`).
class NodeJSService {
    enum State: String {
        case stopped = "STOPPED"
        case starting = "STARTING"
        case started = "STARTED"
        case stopping = "STOPPING"
        case error = "ERROR"
    }

    /// Structured detail attached to .error transitions sourced from the
    /// backend's `{type:"error",phase,message,stack?}` control frame, or
    /// from local rootkey-load / startup failures. `phase` mirrors the
    /// backend's phase strings (`listen-control`, `init`, `construct`,
    /// `runtime`) plus the local `rootkey` and `node-runtime`.
    struct ErrorInfo: Equatable {
        let phase: String
        let message: String
    }

    /// A blocking function that runs the Node.js runtime.
    /// Takes an array of arguments (e.g. ["node", jsPath, ...]) and blocks until Node exits.
    /// Returns the exit code.
    typealias NodeEntryPoint = (_ arguments: [String]) -> Int32

    /// Throws-or-returns the 16-byte rootkey. Native code reads from a
    /// keychain-backed `RootKeyStore` in production; tests inject a fixed
    /// vector. Called once per `start()`, off the main thread, after the
    /// control IPC has connected and Node has broadcast `started`.
    typealias RootKeyProvider = () throws -> Data

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

    var onStateChange: ((State) -> Void)?

    private(set) var state: State = .stopped {
        didSet {
            if oldValue != state {
                log("NodeJSService state: \(oldValue.rawValue) -> \(state.rawValue)")
            }
        }
    }

    /// Last error detail observed during this service's lifetime. Set
    /// alongside an .error transition by `transitionToError`. Reads are
    /// guarded by `lock`; consumers should call `getLastError()` rather
    /// than reading the storage directly.
    private var _lastError: ErrorInfo?

    func getLastError() -> ErrorInfo? {
        lock.lock()
        defer { lock.unlock() }
        return _lastError
    }

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
        startupTimeout: TimeInterval = 30
    ) {
        self.socketDir = socketDir
        self.privateStorageDir = privateStorageDir
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

    /// Transitions to `newState` under the lock and fires `onStateChange`
    /// outside it. Callers must NOT hold `lock` when calling this; the callback
    /// otherwise runs while the lock is held, which would deadlock if the
    /// observer re-enters any other locked method.
    private func transitionState(to newState: State) {
        lock.lock()
        let changed = state != newState
        let leavingStarting = changed && state == .starting
        state = newState
        let watchdog = leavingStarting ? startupWatchdog : nil
        if leavingStarting { startupWatchdog = nil }
        lock.unlock()
        // Cancel the watchdog outside the lock — `cancel()` doesn't take
        // any of our locks but the principle (no callbacks under lock)
        // holds for any future addition here.
        watchdog?.cancel()
        if changed { onStateChange?(newState) }
    }

    /// Records error detail and transitions to .error. Callers must NOT
    /// hold `lock` (same reason as `transitionState`).
    private func transitionToError(phase: String, message: String) {
        lock.lock()
        _lastError = ErrorInfo(phase: phase, message: message)
        lock.unlock()
        log("NodeJSService error (\(phase)): \(message)")
        transitionState(to: .error)
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
        transitionState(to: .starting)

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
                self.transitionToError(
                    phase: "starting-timeout",
                    message: "Service did not reach .started within \(Int(self.startupTimeout))s"
                )
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

    /// Routes raw control-socket frames into lifecycle transitions.
    ///
    /// Frames are JSON of the shape `{"type":"<name>",…}` (well-known
    /// names: `started`, `ready`, `error`). We're already on the IPC's
    /// receive queue and the init-frame send dispatches async on the
    /// IPC's send queue, so a real parser costs nothing in latency or
    /// ordering and gains us forward-compat for additional fields.
    private func handleControlMessage(_ message: String) {
        log("Control IPC received: \(message)")
        guard let frame = parseFrame(message),
              let type = frame["type"] as? String, !type.isEmpty
        else { return }
        switch type {
        case "started":
            sendInitFrame()
        case "ready":
            // Don't downgrade from .stopping back to .started — stop() may
            // have raced ahead of the backend's `ready` broadcast.
            lock.lock()
            let canPromote = (state == .starting)
            lock.unlock()
            if canPromote { transitionState(to: .started) }
        case "error":
            let phase = (frame["phase"] as? String) ?? "unknown"
            let msg = (frame["message"] as? String) ?? "(no message)"
            transitionToError(phase: phase, message: msg)
        default:
            // Forward-compat: a newer backend may emit frame types this
            // build doesn't recognise. Log so it's discoverable but don't
            // transition to .error — the startup watchdog covers genuine
            // protocol breakage where `ready` never arrives.
            log("NodeJSService: ignoring unknown control frame type=\"\(type)\"")
        }
    }

    private func parseFrame(_ message: String) -> [String: Any]? {
        guard let data = message.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            log("Ignoring non-JSON control frame")
            return nil
        }
        return obj
    }

    /// Reads the rootkey, base64-encodes, and ships the init frame on the
    /// control socket. Called exactly once per start cycle, in response to
    /// the backend's `started` broadcast.
    ///
    /// Failures transition to `.error` and capture the cause via
    /// `transitionToError`. We deliberately do **not** tear down the node
    /// thread here: `.error` is observable by the application (via the
    /// JS `stateChange` event), and recovery — calling `stop()`+`cleanup()`
    /// then re-creating the service, prompting the user, etc. — is the
    /// application's responsibility. Tearing down inside this layer would
    /// race with the application's own ERROR observation.
    ///
    /// See the `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` note in
    /// `RootKeyStore`: a device that has never been unlocked since reboot
    /// will throw here. The application can re-attempt by tearing down
    /// the service and creating a new one once the device is unlocked.
    private func sendInitFrame() {
        guard let ipc = controlIPC else { return }
        var keyBytes: Data
        do {
            keyBytes = try rootKeyProvider()
        } catch {
            transitionToError(phase: "rootkey", message: error.localizedDescription)
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
        ipc.sendMessage(frame)
        log("Sent init frame to backend")
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
        transitionState(to: .stopping)

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
            log("Sent shutdown message to Node.js")
        }

        // Wait for node thread to complete (node_start blocks until exit)
        let result = completionSem?.wait(timeout: .now() + timeout)
        let threadExited = (result != .timedOut)
        if !threadExited {
            log("Graceful shutdown timed out after \(timeout)s — node thread still alive")
        }

        cleanup(threadExited: threadExited)
    }

    private func runNode() {
        guard let jsPath = resolveJSEntryPoint() else {
            lock.lock()
            let sem = nodeCompletionSemaphore
            lock.unlock()
            transitionToError(
                phase: "node-runtime",
                message: "Could not find nodejs-project/index.mjs in app bundle"
            )
            sem?.signal()
            return
        }

        lock.lock()
        let completionSem = nodeCompletionSemaphore
        lock.unlock()
        // Stay in `.starting` while Node spins up — the transition to
        // `.started` now waits for the backend's `ready` broadcast (after
        // ComapeoManager is constructed), driven by `handleControlMessage`.

        // argv shape matches Android's NodeJSService.kt:
        //   [node, indexPath, comapeoSocketPath, controlSocketPath, privateStorageDir]
        // The third positional is consumed by backend/index.js as
        // `privateStorageDir` and handed to createComapeo({privateStorageDir,...}).
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
        let args = [
            "node",
            "--no-experimental-fetch",
            jsPath,
            comapeoSocketPath,
            controlSocketPath,
            privateStorageDir,
        ]
        let exitCode = nodeEntryPoint(args)
        log("Node.js exited with code \(exitCode)")

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
            transitionState(to: .stopped)
        } else {
            transitionToError(
                phase: "shutdown-timeout",
                message: "Graceful shutdown timed out — node thread still alive"
            )
        }
    }

    private func deleteSocketFiles() {
        let fm = FileManager.default
        try? fm.removeItem(atPath: comapeoSocketPath)
        try? fm.removeItem(atPath: controlSocketPath)
    }

}
