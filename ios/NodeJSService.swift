import Foundation

/// Manages the lifecycle of an embedded Node.js process on iOS.
///
/// Unlike Android (which uses a foreground service in a separate process), iOS runs
/// Node.js in-process. Graceful shutdown is triggered when the app enters background
/// or is about to be terminated. The UIKit-specific background task handling lives in
/// `NodeJSService+BackgroundTask.swift`.
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
                onStateChange?(state)
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

        // Unix domain sockets have a hard 104-byte path limit (sockaddr_un.sun_path).
        // The app's Documents/tmp directory can exceed this on iOS simulators, so we
        // always place socket files under /tmp with a short prefix.
        let socketDir = "/tmp/comapeo-\(ProcessInfo.processInfo.processIdentifier)"
        self.comapeoSocketPath = (socketDir as NSString).appendingPathComponent(NodeJSService.comapeoSocketFilename)
        self.stateSocketPath = (socketDir as NSString).appendingPathComponent(NodeJSService.stateSocketFilename)

        self.nodeEntryPoint = nodeEntryPoint
        self.resolveJSEntryPoint = resolveJSEntryPoint

        try? FileManager.default.createDirectory(atPath: filesDir, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(atPath: socketDir, withIntermediateDirectories: true)
        deleteSocketFiles()
    }

    func start() {
        lock.lock()
        guard state == .stopped else {
            lock.unlock()
            log("Cannot start: already in state \(state.rawValue)")
            return
        }
        state = .starting
        nodeCompletionSemaphore = DispatchSemaphore(value: 0)
        lock.unlock()

        deleteSocketFiles()

        // Initialize the state IPC connection (connects asynchronously, waits for socket file)
        stateIPC = NodeJSIPC(socketPath: stateSocketPath) { [weak self] message in
            log("State IPC received: \(message)")
            _ = self
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
        state = .stopping
        let completionSem = nodeCompletionSemaphore
        lock.unlock()

        // Send shutdown message — this causes Node.js JS code to exit,
        // which unblocks node_start() in runNode()
        let shutdownMessage = "{\"type\":\"shutdown\"}"
        if let ipc = stateIPC {
            ipc.sendMessageSync(shutdownMessage)
            log("Sent shutdown message to Node.js")
        }

        // Wait for node thread to complete (node_start blocks until exit)
        let result = completionSem?.wait(timeout: .now() + timeout)
        if result == .timedOut {
            log("Graceful shutdown timed out after \(timeout)s")
        }

        cleanup()
    }

    private func runNode() {
        guard let jsPath = resolveJSEntryPoint() else {
            log("Error: Could not find nodejs-project/index.js in app bundle")
            lock.lock()
            state = .error
            lock.unlock()
            nodeCompletionSemaphore?.signal()
            return
        }

        lock.lock()
        state = .started
        let completionSem = nodeCompletionSemaphore
        lock.unlock()

        let args = ["node", jsPath, comapeoSocketPath, stateSocketPath]
        let exitCode = nodeEntryPoint(args)
        log("Node.js exited with code \(exitCode)")

        // Signal that the node thread has finished
        completionSem?.signal()
    }

    func cleanup() {
        stateIPC?.disconnect()
        stateIPC = nil
        deleteSocketFiles()

        lock.lock()
        // Signal in case cleanup is called directly (e.g., from background task expiration)
        nodeCompletionSemaphore?.signal()
        nodeCompletionSemaphore = nil
        nodeThread = nil
        if state != .stopped {
            state = .stopped
        }
        lock.unlock()
    }

    private func deleteSocketFiles() {
        let fm = FileManager.default
        try? fm.removeItem(atPath: comapeoSocketPath)
        try? fm.removeItem(atPath: stateSocketPath)
    }

}
