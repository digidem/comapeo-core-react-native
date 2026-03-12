import XCTest
@testable import ComapeoCore

/// Integration tests for NodeJSIPC Unix domain socket communication.
///
/// These tests create a mock Unix domain socket server (via `MockNodeServer`)
/// and verify that NodeJSIPC can connect, send, and receive length-prefixed
/// JSON messages correctly — mirroring Android's `NodeJSIPCTest.kt`.
final class NodeJSIPCTests: XCTestCase {

    private var testDir: String!

    override func setUp() {
        super.setUp()
        // Use /tmp with a short prefix to stay within sockaddr_un.sun_path's 104-byte limit.
        // NSTemporaryDirectory() returns a long path (e.g. /var/folders/.../T/) that,
        // combined with UUID and socket filenames, can exceed 104 bytes and cause
        // silent truncation leading to bind() EADDRINUSE failures.
        let shortID = UUID().uuidString.prefix(8)
        testDir = "/tmp/cmt-\(shortID)"
        try? FileManager.default.createDirectory(atPath: testDir, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(atPath: testDir)
        super.tearDown()
    }

    // MARK: - Connection Tests

    func testConnectsToServer() throws {
        let server = try startServer(name: "connect.sock")
        defer { server.stop() }

        let connectedExpectation = expectation(description: "Client connected")

        let ipc = NodeJSIPC(socketPath: server.socketPath) { _ in }

        DispatchQueue.global().async {
            let clientFd = server.acceptClient()
            if clientFd >= 0 {
                connectedExpectation.fulfill()
                close(clientFd)
            }
        }

        waitForExpectations(timeout: 5)
        ipc.disconnect()
    }

    func testConnectWhenAlreadyConnectedIsNoop() throws {
        let server = try startServer(name: "already-connected.sock")
        defer { server.stop() }

        let ipc = NodeJSIPC(socketPath: server.socketPath) { _ in }

        DispatchQueue.global().async {
            let clientFd = server.acceptClient()
            if clientFd >= 0 {
                // Keep alive
                Thread.sleep(forTimeInterval: 3)
                close(clientFd)
            }
        }

        // Wait for initial connection
        Thread.sleep(forTimeInterval: 0.5)

        // Call connect() again — should be a no-op
        ipc.connect()
        Thread.sleep(forTimeInterval: 0.2)

        XCTAssertEqual(ipc.state, .connected, "State should remain connected")
        ipc.disconnect()
    }

    func testDisconnectWhenAlreadyDisconnectedIsNoop() throws {
        let socketPath = (testDir as NSString).appendingPathComponent("no-server.sock")

        // Create IPC pointing at non-existent server (will be in connecting state)
        let ipc = NodeJSIPC(socketPath: socketPath) { _ in }
        ipc.disconnect()

        // Second disconnect should not crash
        ipc.disconnect()

        XCTAssertEqual(ipc.state, .disconnected)
    }

    func testWaitsForSocketFileCreation() throws {
        let socketPath = (testDir as NSString).appendingPathComponent("delayed-create.sock")

        let connectedExpectation = expectation(description: "Connected after socket created")

        // Start IPC client before server exists
        let ipc = NodeJSIPC(socketPath: socketPath) { _ in }

        // Create server after a delay
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.3) {
            do {
                let server = MockNodeServer(socketPath: socketPath)
                try server.start()
                let clientFd = server.acceptClient()
                if clientFd >= 0 {
                    connectedExpectation.fulfill()
                    close(clientFd)
                }
                server.stop()
            } catch {
                XCTFail("Failed to create server: \(error)")
            }
        }

        waitForExpectations(timeout: 10)
        ipc.disconnect()
    }

    // MARK: - Message Tests

    func testSendsMessage() throws {
        let server = try startServer(name: "send.sock")
        defer { server.stop() }

        let messageReceived = expectation(description: "Message received by server")
        let testMessage = #"{"type":"hello"}"#

        let ipc = NodeJSIPC(socketPath: server.socketPath) { _ in }

        DispatchQueue.global().async {
            let clientFd = server.acceptClient()
            guard clientFd >= 0 else { return }
            defer { close(clientFd) }

            if let received = MockNodeServer.receiveFramedMessage(fd: clientFd) {
                XCTAssertEqual(received, testMessage)
                messageReceived.fulfill()
            }
        }

        Thread.sleep(forTimeInterval: 0.2)
        ipc.sendMessage(testMessage)

        waitForExpectations(timeout: 5)
        ipc.disconnect()
    }

    func testReceivesMessage() throws {
        let server = try startServer(name: "receive.sock")
        defer { server.stop() }

        let messageReceived = expectation(description: "Message received by client")
        let testMessage = #"{"type":"response","data":"hello from server"}"#

        let ipc = NodeJSIPC(socketPath: server.socketPath) { message in
            XCTAssertEqual(message, testMessage)
            messageReceived.fulfill()
        }

        DispatchQueue.global().async {
            let clientFd = server.acceptClient()
            guard clientFd >= 0 else { return }
            defer { close(clientFd) }

            MockNodeServer.sendFramedMessage(fd: clientFd, message: testMessage)
            Thread.sleep(forTimeInterval: 1)
        }

        waitForExpectations(timeout: 5)
        ipc.disconnect()
    }

    func testRoundTripEcho() throws {
        let server = try startServer(name: "echo.sock")
        defer { server.stop() }

        let echoReceived = expectation(description: "Echo received")
        let testMessage = #"{"type":"ping","id":42}"#

        let ipc = NodeJSIPC(socketPath: server.socketPath) { message in
            XCTAssertEqual(message, testMessage)
            echoReceived.fulfill()
        }

        // Echo server: receives a message and sends it back
        DispatchQueue.global().async {
            let clientFd = server.acceptClient()
            guard clientFd >= 0 else { return }
            defer { close(clientFd) }

            if let received = MockNodeServer.receiveFramedMessage(fd: clientFd) {
                MockNodeServer.sendFramedMessage(fd: clientFd, message: received)
                Thread.sleep(forTimeInterval: 1)
            }
        }

        Thread.sleep(forTimeInterval: 0.2)
        ipc.sendMessage(testMessage)

        waitForExpectations(timeout: 5)
        ipc.disconnect()
    }

    func testMultipleMessages() throws {
        let server = try startServer(name: "multi.sock")
        defer { server.stop() }

        let messageCount = 10
        let allReceived = expectation(description: "All messages received")
        var receivedMessages = [String]()
        let receiveLock = NSLock()

        let ipc = NodeJSIPC(socketPath: server.socketPath) { message in
            receiveLock.lock()
            receivedMessages.append(message)
            if receivedMessages.count == messageCount {
                allReceived.fulfill()
            }
            receiveLock.unlock()
        }

        // Server sends multiple messages
        DispatchQueue.global().async {
            let clientFd = server.acceptClient()
            guard clientFd >= 0 else { return }
            defer { close(clientFd) }

            for i in 0..<messageCount {
                MockNodeServer.sendFramedMessage(fd: clientFd, message: #"{"id":\#(i)}"#)
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
        let server = try startServer(name: "large.sock")
        defer { server.stop() }

        let messageReceived = expectation(description: "Large message received")
        // 64KB message
        let payload = String(repeating: "x", count: 65536)
        let testMessage = #"{"data":"\#(payload)"}"#

        let ipc = NodeJSIPC(socketPath: server.socketPath) { message in
            XCTAssertEqual(message, testMessage)
            messageReceived.fulfill()
        }

        DispatchQueue.global().async {
            let clientFd = server.acceptClient()
            guard clientFd >= 0 else { return }
            defer { close(clientFd) }

            MockNodeServer.sendFramedMessage(fd: clientFd, message: testMessage)
            Thread.sleep(forTimeInterval: 2)
        }

        waitForExpectations(timeout: 5)
        ipc.disconnect()
    }

    // MARK: - Disconnect Tests

    func testServerDisconnectTriggersDisconnectedState() throws {
        let server = try startServer(name: "disconnect.sock")
        defer { server.stop() }

        let ipc = NodeJSIPC(socketPath: server.socketPath) { _ in }

        let serverClosed = expectation(description: "Server closed connection")

        DispatchQueue.global().async {
            let clientFd = server.acceptClient()
            guard clientFd >= 0 else { return }

            close(clientFd)
            serverClosed.fulfill()
        }

        waitForExpectations(timeout: 5)

        // Give time for the disconnect to propagate
        Thread.sleep(forTimeInterval: 0.5)

        let state = ipc.state
        XCTAssertTrue(
            state == .disconnected || {
                if case .error = state { return true }
                return false
            }(),
            "State should be disconnected or error after server closes, got: \(state)"
        )

        ipc.disconnect()
    }

    // MARK: - Helpers

    private func startServer(name: String) throws -> MockNodeServer {
        let socketPath = (testDir as NSString).appendingPathComponent(name)
        let server = MockNodeServer(socketPath: socketPath)
        try server.start()
        return server
    }
}
