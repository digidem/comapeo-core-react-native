import Foundation

/// Unix domain socket IPC client for communicating with Node.js process.
///
/// Uses a length-prefixed JSON framing protocol (4-byte little-endian length prefix
/// followed by UTF-8 JSON payload) over Unix domain sockets — matching the Android
/// `NodeJSIPC.kt` implementation.
///
/// Lifecycle ordering (mirrors Android's `cancelAndJoin`-then-close model):
/// `disconnect()` shuts down the socket to wake any blocked read, joins the
/// receive worker, drains the send queue with a sync barrier, and only then
/// closes the fd. This guarantees no `read(2)`/`write(2)` is in flight against
/// the fd at the moment `close(2)` runs, so the kernel can't reassign the fd
/// number under an active operation.
class NodeJSIPC {
    enum State: Equatable {
        case disconnected
        case connecting
        case connected
        case disconnecting
        case error(String)
    }

    private let socketPath: String
    private let onMessage: (String) -> Void
    private let lock = NSLock()
    /// Unix socket file descriptor. Tests using `@testable import` read this
    /// to tune kernel buffer options (e.g. `SO_SNDBUF`, `O_NONBLOCK`) — they
    /// don't need to mutate it, so the setter stays private.
    private(set) var socket: Int32 = -1

    private let sendQueue = DispatchQueue(label: "com.comapeo.core.ipc.send")
    private let receiveQueue = DispatchQueue(label: "com.comapeo.core.ipc.receive")
    private let connectQueue = DispatchQueue(label: "com.comapeo.core.ipc.connect")

    /// Marker so `disconnect()` can detect re-entrance from the receive loop
    /// (where waiting on `receiveWorkItem` would deadlock).
    ///
    /// This must be per-instance (not `static`) so that `disconnect()` called
    /// on instance B while running inside instance A's receive callback correctly
    /// checks B's own queue, not A's. A `static` key would cause any IPC instance's
    /// receive queue to satisfy the check, skipping the join on the wrong instance
    /// and potentially closing B's fd while B's receive loop is still in flight.
    private let receiveQueueKey = DispatchSpecificKey<Void>()

    private var receiveWorkItem: DispatchWorkItem?
    /// Messages enqueued by `sendMessage` before the socket is connected.
    /// Flushed in connect order when the connection completes. Guarded by `lock`.
    private var pendingMessages: [String] = []

    private(set) var state: State = .disconnected {
        didSet {
            log("IPC state changed: \(oldValue) -> \(state)")
        }
    }

    init(socketPath: String, onMessage: @escaping (String) -> Void) {
        self.socketPath = socketPath
        self.onMessage = onMessage
        receiveQueue.setSpecific(key: receiveQueueKey, value: ())
        log("NodeJSIPC initialized with socket path: \(socketPath)")
        connect()
    }

    func connect() {
        lock.lock()
        // Reject .disconnecting so a sendMessage racing with disconnect()
        // can't flip state back to .connecting while close is in progress.
        // .error is recoverable: callers can retry by calling connect() again.
        switch state {
        case .connected, .connecting, .disconnecting:
            lock.unlock()
            return
        case .error:
            state = .disconnected
            state = .connecting
        case .disconnected:
            state = .connecting
        }
        lock.unlock()

        connectQueue.async { [weak self] in
            self?.performConnect()
        }
    }

    private func performConnect() {
        // Wait for the socket file to appear
        waitForFile(atPath: socketPath, timeoutSeconds: 30)

        // Connect with retry
        do {
            let fd = try connectWithRetry(socketPath: socketPath)
            let messagesToFlush: [String]
            lock.lock()
            // disconnect() may have run while we were waiting/connecting.
            // If state is no longer .connecting, the new fd is orphaned —
            // close it and bail without touching state.
            guard state == .connecting else {
                lock.unlock()
                close(fd)
                return
            }
            self.socket = fd
            state = .connected
            messagesToFlush = pendingMessages
            pendingMessages.removeAll()
            lock.unlock()
            startReceiving()

            // Flush any messages enqueued while connecting.
            for message in messagesToFlush {
                sendQueue.async { [weak self] in
                    self?.sendMessageInternal(message)
                }
            }
        } catch {
            lock.lock()
            // Same race as the success path: only transition to .error if
            // we're still the connect attempt that's expected to.
            if state == .connecting {
                state = .error(error.localizedDescription)
            }
            lock.unlock()
            log("Failed to connect: \(error.localizedDescription)")
        }
    }

    /// Tears down the connection. Safe to call from any thread, including
    /// the receive loop (which calls back here on read errors) — the
    /// `receiveQueueKey` check below skips the join in that case.
    ///
    /// Sequence:
    ///   1. Snapshot fd; transition to .disconnecting.
    ///   2. `shutdown(2)` to wake any blocked `read(2)` in the receive loop.
    ///      Using shutdown rather than close means the fd number can't be
    ///      reassigned while a syscall still holds it.
    ///   3. Join the receive worker (skipped if we ARE the receive worker).
    ///   4. Drain the send queue with a sync barrier so no write is in flight.
    ///   5. `close(2)` the fd. Steps 3+4 guarantee it's no longer in use.
    func disconnect() {
        lock.lock()
        guard state != .disconnecting && state != .disconnected else {
            lock.unlock()
            return
        }
        state = .disconnecting
        let fd = socket
        let workItem = receiveWorkItem
        receiveWorkItem = nil
        lock.unlock()

        // 2. Wake a blocked receive loop.
        if fd >= 0 {
            _ = Darwin.shutdown(fd, SHUT_RDWR)
        }

        // 3. Wait for the receive loop to exit, unless we are it.
        let onReceiveQueue = DispatchQueue.getSpecific(key: receiveQueueKey) != nil
        if !onReceiveQueue {
            workItem?.wait()
        }

        // 4. Drain the send queue. Any in-flight sendMessageInternal finishes
        // here (its write will have failed via shutdown, which is fine).
        sendQueue.sync {}

        // 5. Now safe to close — no read/write can still be using the fd.
        if fd >= 0 {
            close(fd)
        }

        lock.lock()
        socket = -1
        state = .disconnected
        lock.unlock()
    }

    func sendMessage(_ message: String) {
        connect()
        sendQueue.async { [weak self] in
            self?.sendMessageInternal(message)
        }
    }

    /// Sends a message synchronously on the current thread.
    /// Used during shutdown to ensure the message is sent before the process exits.
    func sendMessageSync(_ message: String) {
        sendMessageInternal(message)
    }

    private func sendMessageInternal(_ message: String) {
        lock.lock()
        let fd = socket
        let currentState = state
        lock.unlock()

        if fd < 0 {
            switch currentState {
            case .connecting, .disconnected:
                // Defer until connection completes. performConnect() will
                // flush the pending list in order on success.
                // TODO: bound `pendingMessages` growth. A hot-loop sender
                // pre-connect can grow this without limit. Today the only
                // producer is the bundled JS bridge, which makes the risk
                // theoretical, but matching Android's `Channel.UNLIMITED`
                // is parity-by-coincidence rather than a deliberate choice.
                lock.lock()
                pendingMessages.append(message)
                lock.unlock()
                return
            default:
                log("Cannot send: socket not connected (state: \(currentState))")
                return
            }
        }

        guard let messageBytes = message.data(using: .utf8) else {
            log("Cannot encode message to UTF-8")
            return
        }

        do {
            var length = UInt32(messageBytes.count).littleEndian
            try withUnsafeBytes(of: &length) { prefixPtr in
                try writeFully(fd: fd, buffer: prefixPtr.baseAddress!, count: 4)
            }
            try messageBytes.withUnsafeBytes { bodyPtr in
                try writeFully(fd: fd, buffer: bodyPtr.baseAddress!, count: messageBytes.count)
            }
        } catch {
            log("Failed to send message: \(error.localizedDescription)")
        }
    }

    /// Writes exactly `count` bytes from `buffer`, looping over partial
    /// writes. Handles `EINTR` and `EAGAIN`/`EWOULDBLOCK` (the latter via
    /// `poll`). POSIX `write(2)` on a stream socket is permitted to return
    /// fewer bytes than requested; treating that as fatal desyncs the framed
    /// protocol because the length prefix has already been sent.
    private func writeFully(fd: Int32, buffer: UnsafeRawPointer, count: Int) throws {
        var written = 0
        while written < count {
            let n = Darwin.write(fd, buffer.advanced(by: written), count - written)
            if n > 0 {
                written += n
                continue
            }
            if n < 0 {
                switch errno {
                case EINTR: continue
                case EAGAIN, EWOULDBLOCK:
                    var pfd = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
                    _ = Darwin.poll(&pfd, 1, 5000)
                    continue
                default:
                    throw IPCError.writeError(errno)
                }
            }
            // n == 0 on a stream socket means the peer closed.
            throw IPCError.connectionClosed
        }
    }

    private func startReceiving() {
        let workItem = DispatchWorkItem { [weak self] in
            self?.receiveLoop()
        }
        lock.lock()
        receiveWorkItem = workItem
        lock.unlock()
        receiveQueue.async(execute: workItem)
    }

    private func receiveLoop() {
        while true {
            lock.lock()
            let fd = socket
            let currentState = state
            lock.unlock()

            guard fd >= 0, currentState == .connected else { break }

            do {
                let message = try receiveMessage(fd: fd)
                onMessage(message)
            } catch {
                log("Receive error: \(error.localizedDescription)")
                disconnect()
                break
            }
        }
    }

    private func receiveMessage(fd: Int32) throws -> String {
        // Read 4-byte length prefix
        var lengthBuffer = [UInt8](repeating: 0, count: 4)
        try readFully(fd: fd, buffer: &lengthBuffer, count: 4)

        let messageLength = Int(
            UInt32(lengthBuffer[0]) |
            UInt32(lengthBuffer[1]) << 8 |
            UInt32(lengthBuffer[2]) << 16 |
            UInt32(lengthBuffer[3]) << 24
        )

        // TODO: cap `messageLength` to a sanity bound. A corrupt/hostile
        // length prefix (up to 4 GiB) becomes an immediate allocation here.
        // The peer is the bundled Node.js process so this is a robustness
        // concern, not a security one — Android also runs uncapped today.
        // Read message body
        var messageBuffer = [UInt8](repeating: 0, count: messageLength)
        try readFully(fd: fd, buffer: &messageBuffer, count: messageLength)

        guard let message = String(bytes: messageBuffer, encoding: .utf8) else {
            throw IPCError.invalidUTF8
        }
        return message
    }

    private func readFully(fd: Int32, buffer: inout [UInt8], count: Int) throws {
        var totalRead = 0
        while totalRead < count {
            let bytesRead = Darwin.read(fd, &buffer[totalRead], count - totalRead)
            if bytesRead > 0 {
                totalRead += bytesRead
                continue
            }
            if bytesRead < 0 {
                switch errno {
                case EINTR: continue
                case EAGAIN, EWOULDBLOCK:
                    var pfd = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
                    _ = Darwin.poll(&pfd, 1, 5000)
                    continue
                default:
                    throw IPCError.readError(errno)
                }
            }
            // bytesRead == 0 → peer closed the connection.
            throw IPCError.connectionClosed
        }
    }

    enum IPCError: Error, LocalizedError {
        case connectionFailed(String)
        case connectionClosed
        case readError(Int32)
        case writeError(Int32)
        case invalidUTF8
        case timeout

        var errorDescription: String? {
            switch self {
            case .connectionFailed(let msg): return "Connection failed: \(msg)"
            case .connectionClosed: return "Connection closed by peer"
            case .readError(let code): return "Read error: \(code)"
            case .writeError(let code): return "Write error: \(code)"
            case .invalidUTF8: return "Invalid UTF-8 data"
            case .timeout: return "Connection timed out"
            }
        }
    }
}

// MARK: - Connection helpers

func connectWithRetry(
    socketPath: String,
    maxRetries: Int = 5,
    initialDelayMs: UInt32 = 100,
    maxDelayMs: UInt32 = 5000
) throws -> Int32 {
    var currentDelay = initialDelayMs
    var lastError: Error?

    for attempt in 0..<maxRetries {
        do {
            let fd = try connectSocket(path: socketPath)
            log("Connected on attempt \(attempt + 1)")
            return fd
        } catch {
            lastError = error
            if attempt < maxRetries - 1 {
                usleep(currentDelay * 1000)
                currentDelay = min(currentDelay * 2, maxDelayMs)
            }
        }
    }

    throw NodeJSIPC.IPCError.connectionFailed(
        "Failed after \(maxRetries) attempts: \(lastError?.localizedDescription ?? "unknown")"
    )
}

func connectSocket(path: String) throws -> Int32 {
    let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else {
        throw NodeJSIPC.IPCError.connectionFailed("socket() failed: \(errno)")
    }

    // Suppress SIGPIPE for writes to this fd. Without this, a write
    // to a closed peer — a routine failure mode during shutdown
    // races (e.g. `service.stop()` sending the shutdown frame after
    // the backend already closed) — would deliver SIGPIPE to the
    // process and kill it. `writeFully` already handles `EPIPE` in
    // its error path; SO_NOSIGPIPE turns the kernel signal into a
    // normal `errno` so the existing path runs.
    var noSigPipe: Int32 = 1
    _ = setsockopt(
        fd, SOL_SOCKET, SO_NOSIGPIPE,
        &noSigPipe, socklen_t(MemoryLayout<Int32>.size)
    )

    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)

    let pathBytes = path.utf8CString
    guard pathBytes.count <= MemoryLayout.size(ofValue: addr.sun_path) else {
        close(fd)
        throw NodeJSIPC.IPCError.connectionFailed("Socket path too long")
    }

    let sunPathSize = MemoryLayout.size(ofValue: addr.sun_path)
    withUnsafeMutableBytes(of: &addr.sun_path) { rawBuf in
        let ptr = rawBuf.baseAddress!.assumingMemoryBound(to: CChar.self)
        for (i, byte) in pathBytes.enumerated() where i < sunPathSize {
            ptr[i] = byte
        }
    }

    // addrLen covers the fixed header (sa_family_t = 1 byte on Darwin, where
    // sun_len is a separate byte making offsetof(sun_path) = 2) plus the
    // null-terminated path. This is technically 1 byte short of the textbook
    // `offsetof(sun_path) + strlen + 1` formula, but Darwin's connect(2) is
    // lenient about the supplied length as long as it covers the actual path.
    // MockNodeServer uses the same formula for bind(2), so client and server
    // are consistently matched.
    let addrLen = socklen_t(MemoryLayout<sa_family_t>.size + pathBytes.count)
    let result = withUnsafePointer(to: &addr) { addrPtr in
        addrPtr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPtr in
            Darwin.connect(fd, sockaddrPtr, addrLen)
        }
    }

    guard result == 0 else {
        let err = errno
        close(fd)
        throw NodeJSIPC.IPCError.connectionFailed("connect() failed: \(err)")
    }

    return fd
}

// MARK: - File watching

/// Waits for a file to appear at the given path, polling at 50ms intervals.
func waitForFile(atPath path: String, timeoutSeconds: TimeInterval = 30) {
    let fileManager = FileManager.default
    if fileManager.fileExists(atPath: path) {
        return
    }

    let parentDir = (path as NSString).deletingLastPathComponent
    // Ensure parent directory exists
    try? fileManager.createDirectory(atPath: parentDir, withIntermediateDirectories: true)

    let deadline = Date().addingTimeInterval(timeoutSeconds)
    let pollInterval: useconds_t = 50_000 // 50ms

    while !fileManager.fileExists(atPath: path) {
        if Date() > deadline {
            log("Timeout waiting for file: \(path)")
            return
        }
        usleep(pollInterval)
    }
}
