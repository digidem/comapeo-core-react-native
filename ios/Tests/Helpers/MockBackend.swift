import Foundation

/// Stands in for the Node.js backend during macOS swift-test runs.
///
/// Wraps a `MockNodeServer` bound to the service's control socket and runs
/// the same readiness handshake the real backend does:
///
/// 1. Accept the service's `NodeJSIPC` connection.
/// 2. Send `{"type":"started"}`.
/// 3. Read the service's `{"type":"init","rootKey":"<b64>"}` response.
/// 4. Send `{"type":"ready"}`.
///
/// This is what flips `NodeJSService` from `.starting` to `.started` now that
/// the transition is gated on receiving `ready` rather than on `runNode()`
/// being scheduled. Tests that don't need to inspect the init frame can call
/// `start()` and forget; tests that want to assert on the rootkey can read
/// `receivedRootKey` afterwards.
final class MockBackend {
    private let server: MockNodeServer
    private let queue = DispatchQueue(label: "com.comapeo.core.tests.mock-backend")
    private let lock = NSLock()
    private var clientFd: Int32 = -1
    /// Captured init-frame `rootKey` bytes (base64-decoded). Set after the
    /// handshake completes; nil if no init frame was received.
    private(set) var receivedRootKey: Data?
    /// Set when the service sends `{"type":"shutdown"}` after the handshake.
    private(set) var receivedShutdown = false
    private var handshakeComplete = DispatchSemaphore(value: 0)

    init(controlSocketPath: String) {
        self.server = MockNodeServer(socketPath: controlSocketPath)
    }

    deinit {
        stop()
    }

    /// Binds the control socket and runs the handshake loop on a background
    /// queue. Returns once the server is listening; the actual handshake
    /// happens asynchronously as the service's IPC connects.
    func start() throws {
        try server.start()
        queue.async { [weak self] in
            self?.runLoop()
        }
    }

    /// Blocks until the handshake completes (the `init` frame has been read
    /// and `ready` sent), or `timeout` elapses.
    @discardableResult
    func waitForHandshake(timeout: TimeInterval = 5) -> Bool {
        return handshakeComplete.wait(timeout: .now() + timeout) == .success
    }

    /// Sends a raw frame string on the connected client socket. Tests use
    /// this to inject `error` (or other) frames after the handshake
    /// completes — the production backend would broadcast these via
    /// `controlIpcServer.broadcast({type:"error", …})`. Returns false if
    /// the client hasn't connected yet (call `waitForHandshake` first if
    /// you need to guarantee connectivity).
    @discardableResult
    func sendFrame(_ raw: String) -> Bool {
        lock.lock()
        let fd = clientFd
        lock.unlock()
        guard fd >= 0 else { return false }
        MockNodeServer.sendFramedMessage(fd: fd, message: raw)
        return true
    }

    func stop() {
        lock.lock()
        let fd = clientFd
        clientFd = -1
        lock.unlock()
        if fd >= 0 { close(fd) }
        server.stop()
    }

    /// Accepts the client, runs the handshake, then keeps reading frames so
    /// tests can observe shutdown messages. Errors silently — production
    /// code already covers the failure modes; this exists to unblock tests.
    private func runLoop() {
        let fd = server.acceptClient()
        guard fd >= 0 else {
            handshakeComplete.signal()
            return
        }
        lock.lock()
        clientFd = fd
        lock.unlock()

        MockNodeServer.sendFramedMessage(fd: fd, message: #"{"type":"started"}"#)

        // The frame after `started` is either `init` (happy path) or
        // `error-native` (service-side rootkey/watchdog failure). The
        // production backend's `handleFatal` re-broadcasts the latter
        // as `error` and exits the process; mirror that here so the
        // service stays in `.error` instead of being flipped back to
        // STARTED by a blind `ready`.
        let frameAfterStarted = MockNodeServer.receiveFramedMessage(fd: fd)
        if let frame = frameAfterStarted, frame.contains("\"error-native\"") {
            let (phase, message) = MockBackend.extractErrorNative(fromFrame: frame)
            let errorFrame =
                #"{"type":"error","phase":"\#(phase)","message":"\#(message)"}"#
            MockNodeServer.sendFramedMessage(fd: fd, message: errorFrame)
            handshakeComplete.signal()
            return
        }
        if let initFrame = frameAfterStarted {
            receivedRootKey = MockBackend.extractRootKey(fromInitFrame: initFrame)
        }
        MockNodeServer.sendFramedMessage(fd: fd, message: #"{"type":"ready"}"#)
        handshakeComplete.signal()

        // Continue reading so a subsequent shutdown frame is observed by
        // tests that drive `service.stop()`. On shutdown, mirror the
        // production backend's behavior: broadcast `stopping` BEFORE
        // closing the connection. The service's exit-classification
        // logic relies on this — without `stopping`, an exit during
        // STARTED is classified as unexpected (= ERROR).
        while true {
            guard let frame = MockNodeServer.receiveFramedMessage(fd: fd) else { return }
            if frame.contains("\"shutdown\"") {
                lock.lock()
                receivedShutdown = true
                lock.unlock()
                MockNodeServer.sendFramedMessage(fd: fd, message: #"{"type":"stopping"}"#)
                return
            }
        }
    }

    /// Extracts the base64-decoded rootKey from a string like
    /// `{"type":"init","rootKey":"<b64>"}`. Cheap manual parse — the format
    /// is fixed-shape (Swift writes the JSON itself with no whitespace).
    private static func extractRootKey(fromInitFrame frame: String) -> Data? {
        guard frame.contains("\"init\"") else { return nil }
        guard let range = frame.range(of: "\"rootKey\":\"") else { return nil }
        let valueStart = range.upperBound
        guard let endQuote = frame.range(of: "\"", range: valueStart..<frame.endIndex) else {
            return nil
        }
        let b64 = String(frame[valueStart..<endQuote.lowerBound])
        return Data(base64Encoded: b64)
    }

    /// Extracts `(phase, message)` from a string like
    /// `{"type":"error-native","phase":"...","message":"..."}`. Matches the
    /// shape `JSONSerialization` emits from `NodeJSService.sendErrorNativeFrame`.
    /// Returns empty strings for missing fields so the synthesized response
    /// frame is still well-formed.
    private static func extractErrorNative(fromFrame frame: String) -> (String, String) {
        func extract(_ key: String) -> String {
            guard let r = frame.range(of: "\"\(key)\":\"") else { return "" }
            let start = r.upperBound
            guard let end = frame.range(of: "\"", range: start..<frame.endIndex) else {
                return ""
            }
            return String(frame[start..<end.lowerBound])
        }
        return (extract("phase"), extract("message"))
    }
}
