import Foundation

/// Unix-domain-socket IPC client for the Node.js process. Length-prefixed
/// JSON framing (4-byte LE length + UTF-8 payload), matching Android's
/// `NodeJSIPC.kt`.
///
/// `disconnect()` mirrors Android's `cancelAndJoin`-then-close: shutdown
/// to wake any blocked read, join the receive worker, drain the send
/// queue, then close — guaranteeing no syscall is in flight when the
/// kernel could reassign the fd number.
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
    /// Read-only outside the class. Tests use `@testable import` to tune
    /// kernel buffer options (e.g. `SO_SNDBUF`); they don't mutate it.
    private(set) var socket: Int32 = -1

    private let sendQueue = DispatchQueue(label: "com.comapeo.core.ipc.send")
    private let receiveQueue = DispatchQueue(label: "com.comapeo.core.ipc.receive")
    private let connectQueue = DispatchQueue(label: "com.comapeo.core.ipc.connect")

    /// Per-instance marker so `disconnect()` can detect re-entrance from
    /// the receive loop (where waiting on `receiveWorkItem` would
    /// deadlock). MUST be per-instance: a `static` key would let
    /// instance A's receive queue satisfy instance B's check and skip
    /// the join on the wrong instance.
    private let receiveQueueKey = DispatchSpecificKey<Void>()

    private var receiveWorkItem: DispatchWorkItem?
    /// Messages enqueued before the socket connects. Flushed in order
    /// on success. Guarded by `lock`.
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
        // Reject .disconnecting so a racing sendMessage can't flip back to
        // .connecting mid-close. .error is recoverable via retry.
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
        waitForFile(atPath: socketPath, timeoutSeconds: 30)

        do {
            let fd = try connectWithRetry(socketPath: socketPath)
            let messagesToFlush: [String]
            lock.lock()
            // disconnect() may have run while we connected. If state isn't
            // .connecting any more, the new fd is orphaned — close + bail.
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

            for message in messagesToFlush {
                sendQueue.async { [weak self] in
                    self?.sendMessageInternal(message)
                }
            }
        } catch {
            lock.lock()
            // Only transition to .error if we're still the active attempt.
            if state == .connecting {
                state = .error(error.localizedDescription)
            }
            lock.unlock()
            log("Failed to connect: \(error.localizedDescription)")
        }
    }

    /// Tears down the connection. Safe from any thread, including the
    /// receive loop itself (where the `receiveQueueKey` check below
    /// skips the join to avoid deadlock).
    ///
    /// Order: shutdown the fd (wakes a blocked read), join the receive
    /// worker, drain the send queue, then close. Shutdown-before-close
    /// keeps the fd number alive while syscalls drain.
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

        if fd >= 0 {
            _ = Darwin.shutdown(fd, SHUT_RDWR)
        }

        let onReceiveQueue = DispatchQueue.getSpecific(key: receiveQueueKey) != nil
        if !onReceiveQueue {
            workItem?.wait()
        }

        // Any in-flight write finishes here (its syscall fails via shutdown).
        sendQueue.sync {}

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

    /// Synchronous send on the current thread. Used at shutdown so the
    /// frame is on the wire before the process exits.
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
                // TODO: bound `pendingMessages` growth. A pre-connect hot
                // sender can grow it without limit. Today the only producer
                // is the bundled JS bridge so the risk is theoretical.
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

    /// Writes exactly `count` bytes, looping over partial writes. POSIX
    /// stream sockets may return short; treating that as fatal desyncs
    /// the framed protocol (the length prefix has already shipped).
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
        var lengthBuffer = [UInt8](repeating: 0, count: 4)
        try readFully(fd: fd, buffer: &lengthBuffer, count: 4)

        let messageLength = Int(
            UInt32(lengthBuffer[0]) |
            UInt32(lengthBuffer[1]) << 8 |
            UInt32(lengthBuffer[2]) << 16 |
            UInt32(lengthBuffer[3]) << 24
        )

        // TODO: cap `messageLength`. Corrupt prefix up to 4 GiB becomes an
        // immediate allocation. Robustness concern only — the peer is the
        // bundled Node.js process; Android also runs uncapped today.
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

    // SO_NOSIGPIPE turns the SIGPIPE-from-closed-peer write into a
    // normal `errno` (EPIPE), which `writeFully` already handles. Without
    // it, a routine shutdown race would kill the process.
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

    // 1 byte short of the textbook `offsetof(sun_path) + strlen + 1`,
    // but Darwin's connect(2) is lenient as long as the length covers
    // the path. MockNodeServer's bind(2) uses the same formula.
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

/// Polls for `path` to exist at 50ms intervals up to `timeoutSeconds`.
func waitForFile(atPath path: String, timeoutSeconds: TimeInterval = 30) {
    let fileManager = FileManager.default
    if fileManager.fileExists(atPath: path) {
        return
    }

    let parentDir = (path as NSString).deletingLastPathComponent
    try? fileManager.createDirectory(atPath: parentDir, withIntermediateDirectories: true)

    let deadline = Date().addingTimeInterval(timeoutSeconds)
    let pollInterval: useconds_t = 50_000

    while !fileManager.fileExists(atPath: path) {
        if Date() > deadline {
            log("Timeout waiting for file: \(path)")
            return
        }
        usleep(pollInterval)
    }
}
