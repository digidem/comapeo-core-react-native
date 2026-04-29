import Foundation

/// A mock Unix domain socket server for testing IPC communication.
/// Simulates the Node.js side of the socket connection, speaking the same
/// length-prefixed framing protocol as the real Node.js process.
///
/// Shared across `NodeJSIPCTests`, `NodeJSServiceTests`, and `IPCLifecycleTests`
/// to eliminate test helper duplication.
class MockNodeServer {
    let socketPath: String
    private(set) var serverFd: Int32 = -1

    init(socketPath: String) {
        self.socketPath = socketPath
    }

    deinit {
        stop()
    }

    /// Creates and binds the server socket, ready to accept connections.
    func start() throws {
        // sockaddr_un.sun_path is 104 bytes on macOS — validate early.
        let sunPathSize = 104
        guard socketPath.utf8.count < sunPathSize else {
            throw MockServerError.system(
                "Socket path too long (\(socketPath.utf8.count) bytes, max \(sunPathSize - 1)): \(socketPath)"
            )
        }

        unlink(socketPath)

        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            throw MockServerError.system("socket() failed: \(errno)")
        }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = socketPath.utf8CString
        withUnsafeMutableBytes(of: &addr.sun_path) { rawBuf in
            let ptr = rawBuf.baseAddress!.assumingMemoryBound(to: CChar.self)
            for (i, byte) in pathBytes.enumerated() where i < sunPathSize {
                ptr[i] = byte
            }
        }

        let addrLen = socklen_t(MemoryLayout<sa_family_t>.size + pathBytes.count)
        let bindResult = withUnsafePointer(to: &addr) { addrPtr in
            addrPtr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPtr in
                Darwin.bind(fd, sockaddrPtr, addrLen)
            }
        }
        guard bindResult == 0 else {
            let err = errno
            close(fd)
            throw MockServerError.system("bind() failed: \(err)")
        }
        guard Darwin.listen(fd, 5) == 0 else {
            let err = errno
            close(fd)
            throw MockServerError.system("listen() failed: \(err)")
        }

        serverFd = fd
    }

    /// Blocks until a client connects. Returns the client file descriptor.
    /// Suppresses SIGPIPE on the accepted fd so a `write` after the peer
    /// closes returns `EPIPE` instead of killing the test process — this
    /// matches the production `connectSocket` setup and prevents
    /// shutdown-race tests (e.g. `testStopTimeoutTransitionsToErrorNotStopped`,
    /// where the backend closes before the service writes its final
    /// shutdown frame) from terminating the process under us.
    func acceptClient() -> Int32 {
        let clientFd = Darwin.accept(serverFd, nil, nil)
        if clientFd >= 0 {
            var noSigPipe: Int32 = 1
            _ = setsockopt(
                clientFd, SOL_SOCKET, SO_NOSIGPIPE,
                &noSigPipe, socklen_t(MemoryLayout<Int32>.size)
            )
        }
        return clientFd
    }

    /// Closes the server socket and removes the socket file.
    func stop() {
        if serverFd >= 0 {
            close(serverFd)
            serverFd = -1
        }
        unlink(socketPath)
    }

    // MARK: - Framed Message Protocol

    /// Sends a length-prefixed message to a client file descriptor.
    static func sendFramedMessage(fd: Int32, message: String) {
        let messageBytes = message.data(using: .utf8)!
        var length = UInt32(messageBytes.count).littleEndian
        let lengthData = Data(bytes: &length, count: 4)

        lengthData.withUnsafeBytes { ptr in
            _ = Darwin.write(fd, ptr.baseAddress!, 4)
        }
        messageBytes.withUnsafeBytes { ptr in
            _ = Darwin.write(fd, ptr.baseAddress!, messageBytes.count)
        }
    }

    /// Reads a length-prefixed message from a client file descriptor.
    /// Returns nil if the connection is closed or an error occurs.
    static func receiveFramedMessage(fd: Int32) -> String? {
        var lengthBuffer = [UInt8](repeating: 0, count: 4)
        let bytesRead = Darwin.read(fd, &lengthBuffer, 4)
        guard bytesRead == 4 else { return nil }

        let messageLength = Int(
            UInt32(lengthBuffer[0]) |
            UInt32(lengthBuffer[1]) << 8 |
            UInt32(lengthBuffer[2]) << 16 |
            UInt32(lengthBuffer[3]) << 24
        )

        var messageBuffer = [UInt8](repeating: 0, count: messageLength)
        var totalRead = 0
        while totalRead < messageLength {
            let n = Darwin.read(fd, &messageBuffer[totalRead], messageLength - totalRead)
            guard n > 0 else { return nil }
            totalRead += n
        }

        return String(bytes: messageBuffer, encoding: .utf8)
    }

    enum MockServerError: Error, LocalizedError {
        case system(String)

        var errorDescription: String? {
            switch self {
            case .system(let msg): return msg
            }
        }
    }
}
