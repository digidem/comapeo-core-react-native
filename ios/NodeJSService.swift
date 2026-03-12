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

    static let comapeoSocketFilename = "comapeo.sock"
    static let stateSocketFilename = "state.sock"

    private let filesDir: String
    let comapeoSocketPath: String
    let stateSocketPath: String
    private var stateIPC: NodeJSIPC?
    private var nodeThread: Thread?
    private let lock = NSLock()

    /// Signaled by stop() to tell the node thread to exit.
    private var nodeShutdownSemaphore: DispatchSemaphore?
    /// Signaled by the node thread when it has finished exiting.
    private var nodeCompletionSemaphore: DispatchSemaphore?

    var onStateChange: ((State) -> Void)?

    private(set) var state: State = .stopped {
        didSet {
            if oldValue != state {
                log("NodeJSService state: \(oldValue.rawValue) -> \(state.rawValue)")
                onStateChange?(state)
            }
        }
    }

    /// Creates a NodeJSService using the app's Documents directory.
    convenience init() {
        let documentsDir = NSSearchPathForDirectoriesInDomains(.documentDirectory, .userDomainMask, true).first!
        self.init(filesDir: documentsDir)
    }

    /// Creates a NodeJSService with a custom directory (used for testing).
    init(filesDir: String) {
        self.filesDir = filesDir
        self.comapeoSocketPath = (filesDir as NSString).appendingPathComponent(NodeJSService.comapeoSocketFilename)
        self.stateSocketPath = (filesDir as NSString).appendingPathComponent(NodeJSService.stateSocketFilename)
        try? FileManager.default.createDirectory(atPath: filesDir, withIntermediateDirectories: true)
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
        nodeShutdownSemaphore = DispatchSemaphore(value: 0)
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
        let shutdownSem = nodeShutdownSemaphore
        let completionSem = nodeCompletionSemaphore
        lock.unlock()

        // Send shutdown message
        let shutdownMessage = "{\"type\":\"shutdown\"}"
        if let ipc = stateIPC {
            ipc.sendMessageSync(shutdownMessage)
            log("Sent shutdown message to Node.js")
        }

        // Signal the node thread to exit
        shutdownSem?.signal()

        // Wait for node thread to complete
        let result = completionSem?.wait(timeout: .now() + timeout)
        if result == .timedOut {
            log("Graceful shutdown timed out after \(timeout)s")
        }

        cleanup()
    }

    private func runNode() {
        // TODO: Integrate with nodejs-mobile-ios to actually start Node.js.
        // This would call something like:
        //   NodeRunner.startEngine(withArguments: ["node", jsFilePath, comapeoSocketPath, stateSocketPath])
        //
        // For now, update state to started once the socket files appear.

        lock.lock()
        state = .started
        let shutdownSem = nodeShutdownSemaphore
        let completionSem = nodeCompletionSemaphore
        lock.unlock()

        // In a real implementation, this thread would be blocked by the Node.js event loop.
        // The semaphore simulates that blocking behavior for the shutdown flow.
        shutdownSem?.wait()

        // Signal that the node thread has finished
        completionSem?.signal()
    }

    func cleanup() {
        stateIPC?.disconnect()
        stateIPC = nil
        deleteSocketFiles()

        lock.lock()
        // Signal in case cleanup is called directly (e.g., from background task expiration)
        nodeShutdownSemaphore?.signal()
        nodeCompletionSemaphore?.signal()
        nodeShutdownSemaphore = nil
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
