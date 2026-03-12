import Foundation
import UIKit

/// Manages the lifecycle of an embedded Node.js process on iOS.
///
/// Unlike Android (which uses a foreground service in a separate process), iOS runs
/// Node.js in-process. Graceful shutdown is triggered when the app enters background
/// or is about to be terminated, using `UIApplication.beginBackgroundTask` to request
/// additional execution time from the system.
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
    private let comapeoSocketPath: String
    private let stateSocketPath: String
    private var stateIPC: NodeJSIPC?
    private var nodeThread: Thread?
    private let lock = NSLock()
    private var shutdownSemaphore: DispatchSemaphore?

    var onStateChange: ((State) -> Void)?

    private(set) var state: State = .stopped {
        didSet {
            if oldValue != state {
                log("NodeJSService state: \(oldValue.rawValue) -> \(state.rawValue)")
                onStateChange?(state)
            }
        }
    }

    init() {
        let documentsDir = NSSearchPathForDirectoriesInDomains(.documentDirectory, .userDomainMask, true).first!
        self.filesDir = documentsDir
        self.comapeoSocketPath = (documentsDir as NSString).appendingPathComponent(NodeJSService.comapeoSocketFilename)
        self.stateSocketPath = (documentsDir as NSString).appendingPathComponent(NodeJSService.stateSocketFilename)
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
        lock.unlock()

        // Send shutdown message
        let shutdownMessage = "{\"type\":\"shutdown\"}"
        if let ipc = stateIPC {
            ipc.sendMessageSync(shutdownMessage)
            log("Sent shutdown message to Node.js")
        }

        // Wait for Node.js thread to complete
        let semaphore = DispatchSemaphore(value: 0)
        lock.lock()
        shutdownSemaphore = semaphore
        lock.unlock()

        let result = semaphore.wait(timeout: .now() + timeout)
        if result == .timedOut {
            log("Graceful shutdown timed out after \(timeout)s")
        }

        cleanup()
    }

    /// Stops the Node.js process within a background task, requesting additional
    /// execution time from iOS.
    func stopWithBackgroundTask(timeout: TimeInterval = 10) {
        var backgroundTaskID: UIBackgroundTaskIdentifier = .invalid

        backgroundTaskID = UIApplication.shared.beginBackgroundTask(withName: "ComapeoGracefulShutdown") {
            // Expiration handler — system is about to kill us
            log("Background task expiring, forcing cleanup")
            self.cleanup()
            if backgroundTaskID != .invalid {
                UIApplication.shared.endBackgroundTask(backgroundTaskID)
                backgroundTaskID = .invalid
            }
        }

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            self?.stop(timeout: timeout)
            if backgroundTaskID != .invalid {
                UIApplication.shared.endBackgroundTask(backgroundTaskID)
                backgroundTaskID = .invalid
            }
        }
    }

    private func runNode() {
        // TODO: Integrate with nodejs-mobile-ios to actually start Node.js.
        // This would call something like:
        //   NodeRunner.startEngine(withArguments: ["node", jsFilePath, comapeoSocketPath, stateSocketPath])
        //
        // For now, update state to started once the socket files appear.

        lock.lock()
        state = .started
        lock.unlock()

        // Block this thread until shutdown is requested
        let semaphore = DispatchSemaphore(value: 0)
        lock.lock()
        shutdownSemaphore = semaphore
        lock.unlock()

        // In a real implementation, this thread would be blocked by the Node.js event loop.
        // The semaphore simulates that blocking behavior for the shutdown flow.
        semaphore.wait()

        lock.lock()
        state = .stopped
        // Signal any waiters in stop()
        shutdownSemaphore?.signal()
        lock.unlock()
    }

    private func cleanup() {
        stateIPC?.disconnect()
        stateIPC = nil
        deleteSocketFiles()

        lock.lock()
        shutdownSemaphore?.signal()
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
