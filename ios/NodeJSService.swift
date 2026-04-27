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

    /// A blocking function that runs the Node.js runtime.
    /// Takes an array of arguments (e.g. ["node", jsPath, ...]) and blocks until Node exits.
    /// Returns the exit code.
    typealias NodeEntryPoint = (_ arguments: [String]) -> Int32

    static let comapeoSocketFilename = "comapeo.sock"
    static let stateSocketFilename = "state.sock"

    private let filesDir: String
    let comapeoSocketPath: String
    let stateSocketPath: String
    private var stateIPC: NodeJSIPC?
    private var nodeThread: Thread?
    private let lock = NSLock()

    /// Signaled by the node thread when it has finished exiting.
    private var nodeCompletionSemaphore: DispatchSemaphore?

    /// The function used to start Node.js. Can be replaced for testing.
    private let nodeEntryPoint: NodeEntryPoint

    /// How to locate the bundled JS entry point. Can be replaced for testing.
    private let resolveJSEntryPoint: () -> String?

    var onStateChange: ((State) -> Void)?

    private(set) var state: State = .stopped {
        didSet {
            if oldValue != state {
                log("NodeJSService state: \(oldValue.rawValue) -> \(state.rawValue)")
            }
        }
    }

    /// Creates a NodeJSService with a custom directory.
    /// - Parameters:
    ///   - filesDir: Directory for socket files and working data.
    ///   - nodeEntryPoint: Blocking function that runs Node.js.
    ///   - resolveJSEntryPoint: Returns the path to the JS entry file.
    init(
        filesDir: String,
        nodeEntryPoint: @escaping NodeEntryPoint,
        resolveJSEntryPoint: @escaping () -> String?
    ) {
        self.filesDir = filesDir
        self.comapeoSocketPath = (filesDir as NSString).appendingPathComponent(NodeJSService.comapeoSocketFilename)
        self.stateSocketPath = (filesDir as NSString).appendingPathComponent(NodeJSService.stateSocketFilename)

        // Fail loudly if either socket path won't fit in sockaddr_un.sun_path
        // (104 bytes on Darwin, including the null terminator). A silently
        // truncated path causes bind() to succeed against a different file —
        // surfacing later as a mysterious connection-refused or hang.
        let sunPathMax = 104
        for path in [comapeoSocketPath, stateSocketPath] {
            let needed = path.utf8.count + 1
            precondition(
                needed <= sunPathMax,
                "Socket path too long for sockaddr_un.sun_path (\(needed) > \(sunPathMax)): \(path)"
            )
        }

        self.nodeEntryPoint = nodeEntryPoint
        self.resolveJSEntryPoint = resolveJSEntryPoint

        try? FileManager.default.createDirectory(atPath: filesDir, withIntermediateDirectories: true)
        deleteSocketFiles()
    }

    /// Transitions to `newState` under the lock and fires `onStateChange`
    /// outside it. Callers must NOT hold `lock` when calling this; the callback
    /// otherwise runs while the lock is held, which would deadlock if the
    /// observer re-enters any other locked method.
    private func transitionState(to newState: State) {
        lock.lock()
        let changed = state != newState
        state = newState
        lock.unlock()
        if changed { onStateChange?(newState) }
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

        deleteSocketFiles()

        // Initialize the state IPC connection (connects asynchronously, waits for socket file)
        stateIPC = NodeJSIPC(socketPath: stateSocketPath) { message in
            log("State IPC received: \(message)")
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
        // which unblocks node_start() in runNode()
        let shutdownMessage = "{\"type\":\"shutdown\"}"
        if let ipc = stateIPC {
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
            log("Error: Could not find nodejs-project/index.js in app bundle")
            lock.lock()
            let sem = nodeCompletionSemaphore
            lock.unlock()
            transitionState(to: .error)
            sem?.signal()
            return
        }

        lock.lock()
        let completionSem = nodeCompletionSemaphore
        lock.unlock()
        transitionState(to: .started)

        let args = ["node", jsPath, comapeoSocketPath, stateSocketPath]
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
        stateIPC?.disconnect()
        stateIPC = nil
        deleteSocketFiles()

        lock.lock()
        // Signal in case cleanup is called directly (e.g., from background task expiration)
        nodeCompletionSemaphore?.signal()
        nodeCompletionSemaphore = nil
        nodeThread = nil
        lock.unlock()

        transitionState(to: threadExited ? .stopped : .error)
    }

    private func deleteSocketFiles() {
        let fm = FileManager.default
        try? fm.removeItem(atPath: comapeoSocketPath)
        try? fm.removeItem(atPath: stateSocketPath)
    }

}
