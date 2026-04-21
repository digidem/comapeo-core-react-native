import XCTest
@testable import ComapeoCore

/// Integration tests for NodeJSIPC Unix domain socket communication.
///
/// These tests create a mock Unix domain socket server (via `MockNodeServer`)
/// and verify that NodeJSIPC can connect, send, and receive length-prefixed
/// JSON messages correctly — mirroring Android's `NodeJSIPCTest.kt`.
///
/// Two of the cases below (`testMessagesSentBeforeConnectAreBuffered`,
/// `testLargeMessageIsDeliveredIntactUnderBackpressure`) started life as
/// failing tests documenting real bugs; they now serve as regression tests
/// for the pre-connect buffering and partial-write fixes.
final class NodeJSIPCTests: XCTestCase {

    private var testDir: String!

    override func setUp() {
        super.setUp()
        testDir = TestPaths.makeShortTempDir(prefix: "cmt")
    }

    override func tearDown() {
        TestPaths.removeTempDir(testDir)
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

        // Hold the server-side connection open while we re-call connect() below.
        // A DispatchSemaphore beats a fixed sleep — it makes the "keep alive"
        // intent obvious and ends the moment the test is done.
        let doneWithServer = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            let clientFd = server.acceptClient()
            if clientFd >= 0 {
                doneWithServer.wait()
                close(clientFd)
            }
        }
        defer { doneWithServer.signal() }

        // Wait for the initial async connection to establish, then call
        // connect() again and assert state didn't change.
        waitUntil("IPC should reach .connected", ipc.state == .connected)

        ipc.connect()
        // No state transition should be triggered — but we can't directly
        // observe "no transition", so poll briefly and assert the terminal
        // state is unchanged.
        waitUntil(timeout: 0.2, "state should stay .connected", ipc.state == .connected)
        XCTAssertEqual(ipc.state, .connected, "Second connect() must not change state")

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

        waitUntil("IPC should reach .connected before send", ipc.state == .connected)
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

        // Keep the server-side socket alive until the test signals done.
        let doneWithServer = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            let clientFd = server.acceptClient()
            guard clientFd >= 0 else { return }
            defer { close(clientFd) }

            MockNodeServer.sendFramedMessage(fd: clientFd, message: testMessage)
            doneWithServer.wait()
        }

        waitForExpectations(timeout: 5)
        doneWithServer.signal()
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

        let doneWithServer = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            let clientFd = server.acceptClient()
            guard clientFd >= 0 else { return }
            defer { close(clientFd) }

            if let received = MockNodeServer.receiveFramedMessage(fd: clientFd) {
                MockNodeServer.sendFramedMessage(fd: clientFd, message: received)
            }
            doneWithServer.wait()
        }

        waitUntil("IPC should reach .connected before send", ipc.state == .connected)
        ipc.sendMessage(testMessage)

        waitForExpectations(timeout: 5)
        doneWithServer.signal()
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

        let doneWithServer = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            let clientFd = server.acceptClient()
            guard clientFd >= 0 else { return }
            defer { close(clientFd) }

            for i in 0..<messageCount {
                MockNodeServer.sendFramedMessage(fd: clientFd, message: #"{"id":\#(i)}"#)
            }
            doneWithServer.wait()
        }

        waitForExpectations(timeout: 5)

        receiveLock.lock()
        XCTAssertEqual(receivedMessages.count, messageCount)
        for i in 0..<messageCount {
            XCTAssertEqual(receivedMessages[i], #"{"id":\#(i)}"#)
        }
        receiveLock.unlock()

        doneWithServer.signal()
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

        let doneWithServer = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            let clientFd = server.acceptClient()
            guard clientFd >= 0 else { return }
            defer { close(clientFd) }

            MockNodeServer.sendFramedMessage(fd: clientFd, message: testMessage)
            doneWithServer.wait()
        }

        waitForExpectations(timeout: 5)
        doneWithServer.signal()
        ipc.disconnect()
    }

    // MARK: - Regression: Pre-connect buffering
    //
    // Fixed in commit 67785f1 "Buffer pre-connect sends; loop over partial
    // reads and writes". Before the fix, `sendMessage` calls made while the
    // IPC was still in `.connecting` hit the "socket not connected" guard and
    // were silently dropped. The contract `postMessage` exposes to JS (and
    // that Android honours via `Channel.UNLIMITED`) is that messages queue
    // up and flush on connection.

    func testMessagesSentBeforeConnectAreBuffered() throws {
        let socketPath = (testDir as NSString).appendingPathComponent("buffered.sock")

        // IPC starts connecting but the server socket does not yet exist —
        // NodeJSIPC will be polling inside `waitForFile()`.
        let ipc = NodeJSIPC(socketPath: socketPath) { _ in }
        defer { ipc.disconnect() }

        // Fire two messages while still connecting. These must be buffered
        // and flushed once the connection is established.
        ipc.sendMessage("first")
        ipc.sendMessage("second")

        // Only now does the server appear. waitForFile() should see the socket
        // and performConnect() should complete the connection.
        let server = MockNodeServer(socketPath: socketPath)
        try server.start()
        defer { server.stop() }

        let bothReceived = expectation(description: "Both pending messages received")
        bothReceived.expectedFulfillmentCount = 2
        var received: [String] = []
        let receivedLock = NSLock()

        DispatchQueue.global().async {
            let clientFd = server.acceptClient()
            guard clientFd >= 0 else { return }
            defer { close(clientFd) }

            for _ in 0..<2 {
                guard let msg = MockNodeServer.receiveFramedMessage(fd: clientFd) else { break }
                receivedLock.lock()
                received.append(msg)
                receivedLock.unlock()
                bothReceived.fulfill()
            }
        }

        waitForExpectations(timeout: 15)
        receivedLock.lock()
        XCTAssertEqual(received, ["first", "second"], "Pre-connect messages must be delivered in order")
        receivedLock.unlock()
    }

    // MARK: - Regression: Partial-write handling
    //
    // Fixed in commit 67785f1. Before the fix, `sendMessageInternal` treated
    // any short `write()` return as fatal and bailed out, leaving the
    // receiver desynced because the length prefix had already been sent.
    // We force the short-write path by shrinking `SO_SNDBUF` and turning on
    // `O_NONBLOCK` — production uses a blocking socket where short writes
    // are rare but still permitted (e.g. on `EINTR`).

    func testLargeMessageIsDeliveredIntactUnderBackpressure() throws {
        let server = try startServer(name: "partial-write.sock")
        defer { server.stop() }

        let clientConnected = expectation(description: "Server accepted client")
        let messageReceivedIntact = expectation(description: "Full message received intact")
        let payload = String(repeating: "A", count: 65536) // 64 KiB

        let ipc = NodeJSIPC(socketPath: server.socketPath) { _ in }
        defer { ipc.disconnect() }

        DispatchQueue.global().async {
            let clientFd = server.acceptClient()
            guard clientFd >= 0 else { return }
            clientConnected.fulfill()
            defer { close(clientFd) }

            // Drain slowly so the client-side send buffer fills and stays full —
            // without this, the kernel has plenty of room and no short write occurs.
            let received = MockNodeServer.receiveFramedMessage(fd: clientFd) ?? ""
            if received == payload {
                messageReceivedIntact.fulfill()
            }
        }

        wait(for: [clientConnected], timeout: 5)

        // Wait for the client-side connection to finish and expose its fd.
        waitUntil("Client socket should be open", ipc.socket >= 0)

        // Make the socket non-blocking with a tiny send buffer so the 64 KiB
        // payload cannot fit in one `write()` call.
        let flags = fcntl(ipc.socket, F_GETFL, 0)
        XCTAssertEqual(fcntl(ipc.socket, F_SETFL, flags | O_NONBLOCK), 0, "Failed to set O_NONBLOCK")
        var bufSize: Int32 = 4096
        XCTAssertEqual(
            setsockopt(ipc.socket, SOL_SOCKET, SO_SNDBUF, &bufSize, socklen_t(MemoryLayout<Int32>.size)),
            0,
            "Failed to shrink SO_SNDBUF"
        )

        ipc.sendMessage(payload)

        wait(for: [messageReceivedIntact], timeout: 10)
    }

    // MARK: - Disconnect Tests

    /// When the server closes its end, the IPC's receive loop sees EOF, logs
    /// the read error and transitions to `.disconnected` via `disconnect()`.
    /// The previous version of this assertion tolerated `.error` as well,
    /// which was permissive-by-default rather than deliberate — the read
    /// path never transitions to `.error`. Asserting `.disconnected` exactly
    /// makes the contract explicit.
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

        waitUntil(
            "IPC should transition to .disconnected after server closes",
            ipc.state == .disconnected
        )
        XCTAssertEqual(ipc.state, .disconnected)

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
