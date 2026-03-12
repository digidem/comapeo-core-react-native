import Foundation

/// Unix domain socket IPC client for communicating with Node.js process.
///
/// Uses a length-prefixed JSON framing protocol (4-byte little-endian length prefix
/// followed by UTF-8 JSON payload) over Unix domain sockets — matching the Android
/// `NodeJSIPC.kt` implementation.
class NodeJSIPC {
    enum State: Equatable {
        case disconnected
        case connecting
        case connected
        case disconnecting
        case error(String)

        static func == (lhs: State, rhs: State) -> Bool {
            switch (lhs, rhs) {
            case (.disconnected, .disconnected),
                 (.connecting, .connecting),
                 (.connected, .connected),
                 (.disconnecting, .disconnecting):
                return true
            case (.error(let a), .error(let b)):
                return a == b
            default:
                return false
            }
        }
    }

    private let socketPath: String
    private let onMessage: (String) -> Void
    private let lock = NSLock()
    private var socket: Int32 = -1
    private var sendQueue = DispatchQueue(label: "com.comapeo.core.ipc.send")
    private var receiveQueue = DispatchQueue(label: "com.comapeo.core.ipc.receive")
    private var connectQueue = DispatchQueue(label: "com.comapeo.core.ipc.connect")
    private var receiveWorkItem: DispatchWorkItem?

    private(set) var state: State = .disconnected {
        didSet {
            log("IPC state changed: \(oldValue) -> \(state)")
        }
    }

    init(socketPath: String, onMessage: @escaping (String) -> Void) {
        self.socketPath = socketPath
        self.onMessage = onMessage
        log("NodeJSIPC initialized with socket path: \(socketPath)")
        connect()
    }

    func connect() {
        lock.lock()
        guard state != .connected && state != .connecting else {
            lock.unlock()
            return
        }
        if case .error = state {
            state = .disconnected
        }
        state = .connecting
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
            lock.lock()
            self.socket = fd
            state = .connected
            lock.unlock()
            startReceiving()
        } catch {
            lock.lock()
            state = .error(error.localizedDescription)
            lock.unlock()
            log("Failed to connect: \(error.localizedDescription)")
        }
    }

    func disconnect() {
        lock.lock()
        guard state != .disconnecting && state != .disconnected else {
            lock.unlock()
            return
        }
        state = .disconnecting
        let fd = socket
        socket = -1
        lock.unlock()

        receiveWorkItem?.cancel()
        receiveWorkItem = nil

        if fd >= 0 {
            close(fd)
        }

        lock.lock()
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
        lock.unlock()

        guard fd >= 0 else {
            log("Cannot send: socket not connected")
            return
        }

        guard let messageBytes = message.data(using: .utf8) else {
            log("Cannot encode message to UTF-8")
            return
        }

        // Write 4-byte little-endian length prefix
        var length = UInt32(messageBytes.count).littleEndian
        let lengthData = Data(bytes: &length, count: 4)

        let written1 = lengthData.withUnsafeBytes { ptr in
            Darwin.write(fd, ptr.baseAddress!, 4)
        }
        guard written1 == 4 else {
            log("Failed to write length prefix")
            return
        }

        let written2 = messageBytes.withUnsafeBytes { ptr in
            Darwin.write(fd, ptr.baseAddress!, messageBytes.count)
        }
        guard written2 == messageBytes.count else {
            log("Failed to write message body")
            return
        }
    }

    private func startReceiving() {
        let workItem = DispatchWorkItem { [weak self] in
            self?.receiveLoop()
        }
        receiveWorkItem = workItem
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
            if bytesRead <= 0 {
                if bytesRead == 0 {
                    throw IPCError.connectionClosed
                }
                throw IPCError.readError(errno)
            }
            totalRead += bytesRead
        }
    }

    enum IPCError: Error, LocalizedError {
        case connectionFailed(String)
        case connectionClosed
        case readError(Int32)
        case invalidUTF8
        case timeout

        var errorDescription: String? {
            switch self {
            case .connectionFailed(let msg): return "Connection failed: \(msg)"
            case .connectionClosed: return "Connection closed by peer"
            case .readError(let code): return "Read error: \(code)"
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
