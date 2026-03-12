import XCTest
@testable import ComapeoCore

/// Integration tests for NodeJSIPC Unix domain socket communication.
///
/// These tests create a mock Unix domain socket server and verify that NodeJSIPC
/// can connect, send, and receive length-prefixed JSON messages correctly —
/// mirroring Android's `NodeJSIPCTest.kt`.
final class NodeJSIPCTests: XCTestCase {

    private var testDir: String!

    override func setUp() {
        super.setUp()
        testDir = (NSTemporaryDirectory() as NSString).appendingPathComponent(
            "comapeo-ipc-test-\(UUID().uuidString)"
        )
        try? FileManager.default.createDirectory(atPath: testDir, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(atPath: testDir)
        super.tearDown()
    }

    // MARK: - Mock Server

    /// Creates a Unix domain socket server that listens for one connection.
    /// Returns the server file descriptor.
    private func createMockServer(socketPath: String) throws -> Int32 {
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw NSError(domain: "test", code: Int(errno)) }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)

        let pathBytes = socketPath.utf8CString
        withUnsafeMutablePointer(to: &addr.sun_path) { sunPathPtr in
            sunPathPtr.withMemoryRebound(to: CChar.self, capacity: MemoryLayout.size(ofValue: addr.sun_path)) { ptr in
                for (i, byte) in pathBytes.enumerated() {
                    ptr[i] = byte
                }
            }
        }

        let addrLen = socklen_t(MemoryLayout<sa_family_t>.size + pathBytes.count)
        let bindResult = withUnsafePointer(to: &addr) { addrPtr in
            addrPtr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPtr in
                Darwin.bind(fd, sockaddrPtr, addrLen)
            }
        }
        guard bindResult == 0 else {
            close(fd)
            throw NSError(domain: "test", code: Int(errno), userInfo: [NSLocalizedDescriptionKey: "bind failed"])
        }

        guard Darwin.listen(fd, 1) == 0 else {
            close(fd)
            throw NSError(domain: "test", code: Int(errno), userInfo: [NSLocalizedDescriptionKey: "listen failed"])
        }

        return fd
    }

    /// Accept one client connection from the server socket.
    private func acceptClient(serverFd: Int32) -> Int32 {
        return Darwin.accept(serverFd, nil, nil)
    }

    /// Send a length-prefixed message to a file descriptor.
    private func sendFramedMessage(fd: Int32, message: String) {
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

    /// Receive a length-prefixed message from a file descriptor.
    private func receiveFramedMessage(fd: Int32) -> String? {
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

    // MARK: - Tests

    func testConnectsToServer() throws {
        let socketPath = (testDir as NSString).appendingPathComponent("connect.sock")
        let serverFd = try createMockServer(socketPath: socketPath)
        defer { close(serverFd) }

        let connectedExpectation = expectation(description: "Client connected")

        let ipc = NodeJSIPC(socketPath: socketPath) { _ in }

        // Accept the client connection on a background thread
        DispatchQueue.global().async {
            let clientFd = self.acceptClient(serverFd: serverFd)
            if clientFd >= 0 {
                connectedExpectation.fulfill()
                close(clientFd)
            }
        }

        waitForExpectations(timeout: 5)
        ipc.disconnect()
    }

    func testSendsMessage() throws {
        let socketPath = (testDir as NSString).appendingPathComponent("send.sock")
        let serverFd = try createMockServer(socketPath: socketPath)
        defer { close(serverFd) }

        let messageReceived = expectation(description: "Message received by server")
        let testMessage = #"{"type":"hello"}"#

        // Start IPC client
        let ipc = NodeJSIPC(socketPath: socketPath) { _ in }

        DispatchQueue.global().async {
            let clientFd = self.acceptClient(serverFd: serverFd)
            guard clientFd >= 0 else { return }
            defer { close(clientFd) }

            // Wait a bit for IPC to be ready, then check for message
            if let received = self.receiveFramedMessage(fd: clientFd) {
                XCTAssertEqual(received, testMessage)
                messageReceived.fulfill()
            }
        }

        // Give time for connection to establish
        Thread.sleep(forTimeInterval: 0.2)
        ipc.sendMessage(testMessage)

        waitForExpectations(timeout: 5)
        ipc.disconnect()
    }

    func testReceivesMessage() throws {
        let socketPath = (testDir as NSString).appendingPathComponent("receive.sock")
        let serverFd = try createMockServer(socketPath: socketPath)
        defer { close(serverFd) }

        let messageReceived = expectation(description: "Message received by client")
        let testMessage = #"{"type":"response","data":"hello from server"}"#

        let ipc = NodeJSIPC(socketPath: socketPath) { message in
            XCTAssertEqual(message, testMessage)
            messageReceived.fulfill()
        }

        DispatchQueue.global().async {
            let clientFd = self.acceptClient(serverFd: serverFd)
            guard clientFd >= 0 else { return }
            defer { close(clientFd) }

            // Send a message to the client
            self.sendFramedMessage(fd: clientFd, message: testMessage)
            // Keep connection open long enough for client to receive
            Thread.sleep(forTimeInterval: 1)
        }

        waitForExpectations(timeout: 5)
        ipc.disconnect()
    }

    func testRoundTripEcho() throws {
        let socketPath = (testDir as NSString).appendingPathComponent("echo.sock")
        let serverFd = try createMockServer(socketPath: socketPath)
        defer { close(serverFd) }

        let echoReceived = expectation(description: "Echo received")
        let testMessage = #"{"type":"ping","id":42}"#

        let ipc = NodeJSIPC(socketPath: socketPath) { message in
            XCTAssertEqual(message, testMessage)
            echoReceived.fulfill()
        }

        // Echo server: receives a message and sends it back
        DispatchQueue.global().async {
            let clientFd = self.acceptClient(serverFd: serverFd)
            guard clientFd >= 0 else { return }
            defer { close(clientFd) }

            if let received = self.receiveFramedMessage(fd: clientFd) {
                self.sendFramedMessage(fd: clientFd, message: received)
                Thread.sleep(forTimeInterval: 1)
            }
        }

        // Give time for connection to establish
        Thread.sleep(forTimeInterval: 0.2)
        ipc.sendMessage(testMessage)

        waitForExpectations(timeout: 5)
        ipc.disconnect()
    }

    func testMultipleMessages() throws {
        let socketPath = (testDir as NSString).appendingPathComponent("multi.sock")
        let serverFd = try createMockServer(socketPath: socketPath)
        defer { close(serverFd) }

        let messageCount = 10
        let allReceived = expectation(description: "All messages received")
        var receivedMessages = [String]()
        let receiveLock = NSLock()

        let ipc = NodeJSIPC(socketPath: socketPath) { message in
            receiveLock.lock()
            receivedMessages.append(message)
            if receivedMessages.count == messageCount {
                allReceived.fulfill()
            }
            receiveLock.unlock()
        }

        // Server sends multiple messages
        DispatchQueue.global().async {
            let clientFd = self.acceptClient(serverFd: serverFd)
            guard clientFd >= 0 else { return }
            defer { close(clientFd) }

            for i in 0..<messageCount {
                self.sendFramedMessage(fd: clientFd, message: #"{"id":\#(i)}"#)
            }
            Thread.sleep(forTimeInterval: 2)
        }

        waitForExpectations(timeout: 5)

        receiveLock.lock()
        XCTAssertEqual(receivedMessages.count, messageCount)
        for i in 0..<messageCount {
            XCTAssertEqual(receivedMessages[i], #"{"id":\#(i)}"#)
        }
        receiveLock.unlock()

        ipc.disconnect()
    }

    func testLargeMessage() throws {
        let socketPath = (testDir as NSString).appendingPathComponent("large.sock")
        let serverFd = try createMockServer(socketPath: socketPath)
        defer { close(serverFd) }

        let messageReceived = expectation(description: "Large message received")
        // 64KB message — larger than the 1KB reuse buffer
        let payload = String(repeating: "x", count: 65536)
        let testMessage = #"{"data":"\#(payload)"}"#

        let ipc = NodeJSIPC(socketPath: socketPath) { message in
            XCTAssertEqual(message, testMessage)
            messageReceived.fulfill()
        }

        DispatchQueue.global().async {
            let clientFd = self.acceptClient(serverFd: serverFd)
            guard clientFd >= 0 else { return }
            defer { close(clientFd) }

            self.sendFramedMessage(fd: clientFd, message: testMessage)
            Thread.sleep(forTimeInterval: 2)
        }

        waitForExpectations(timeout: 5)
        ipc.disconnect()
    }

    func testServerDisconnectTriggersDisconnectedState() throws {
        let socketPath = (testDir as NSString).appendingPathComponent("disconnect.sock")
        let serverFd = try createMockServer(socketPath: socketPath)
        defer { close(serverFd) }

        let ipc = NodeJSIPC(socketPath: socketPath) { _ in }

        let serverClosed = expectation(description: "Server closed connection")

        DispatchQueue.global().async {
            let clientFd = self.acceptClient(serverFd: serverFd)
            guard clientFd >= 0 else { return }

            // Close immediately
            close(clientFd)
            serverClosed.fulfill()
        }

        waitForExpectations(timeout: 5)

        // Give time for the disconnect to propagate
        Thread.sleep(forTimeInterval: 0.5)

        let state = ipc.state
        XCTAssertTrue(
            state == .disconnected || state == .error("") || {
                if case .error = state { return true }
                return false
            }(),
            "State should be disconnected or error after server closes, got: \(state)"
        )

        ipc.disconnect()
    }

    func testWaitsForSocketFileCreation() throws {
        let socketPath = (testDir as NSString).appendingPathComponent("delayed-create.sock")

        let connectedExpectation = expectation(description: "Connected after socket created")

        // Start IPC client before server exists
        let ipc = NodeJSIPC(socketPath: socketPath) { _ in }

        // Create server after a delay
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.3) {
            do {
                let serverFd = try self.createMockServer(socketPath: socketPath)
                let clientFd = self.acceptClient(serverFd: serverFd)
                if clientFd >= 0 {
                    connectedExpectation.fulfill()
                    close(clientFd)
                }
                close(serverFd)
            } catch {
                XCTFail("Failed to create server: \(error)")
            }
        }

        waitForExpectations(timeout: 10)
        ipc.disconnect()
    }
}
