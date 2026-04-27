import XCTest
@testable import ComapeoCore

/// End-to-end behavioral tests for the full IPC lifecycle.
///
/// These tests wire up `NodeJSService` + `NodeJSIPC` + a mock socket server
/// to exercise the complete message flow as it would work in the real app:
///
/// 1. Service starts, creating socket files
/// 2. Mock "Node.js" server accepts connections
/// 3. Messages flow bidirectionally through the IPC layer
/// 4. Service stops, sending shutdown message and cleaning up
///
/// This is the highest-value integration test — it verifies the contract
/// between components rather than internal state-machine details.
final class IPCLifecycleTests: XCTestCase {

    private var testDir: String!
    /// Signals to unblock the mock node entry point. Stored on `self` so
    /// `tearDown` can unconditionally release the fake node thread even when
    /// a test fails partway through.
    private var signalNodeExit: (() -> Void)!

    override func setUp() {
        super.setUp()
        testDir = TestPaths.makeShortTempDir(prefix: "cml")
    }

    override func tearDown() {
        // Ensure the mock node thread isn't left blocking
        signalNodeExit?()
        signalNodeExit = nil
        TestPaths.removeTempDir(testDir)
        super.tearDown()
    }

    /// Builds a service wired to the shared mock harness and stores the
    /// signal-exit closure on `self` so `tearDown` can always release it.
    private func makeTestService() -> NodeJSService {
        let (service, signal) = makeMockNodeService(filesDir: testDir)
        signalNodeExit = signal
        return service
    }

    /// Tests a complete message round trip: app sends a request through the
    /// comapeo IPC, mock server receives it and sends a response back.
    func testFullMessageRoundTrip() throws {
        let service = makeTestService()

        // Start service first — its start() calls deleteSocketFiles(), so mock
        // servers must be created afterwards or their socket files get removed.
        let started = expectation(description: "Service started")
        service.onStateChange = { if $0 == .started { started.fulfill() } }
        service.start()
        waitForExpectations(timeout: 5)

        // Create mock servers after start() so deleteSocketFiles() doesn't remove them.
        // The controlIPC is already polling via waitForFile(), so it will connect once
        // the server creates the socket file.
        let comapeoServer = MockNodeServer(socketPath: service.comapeoSocketPath)
        let stateServer = MockNodeServer(socketPath: service.controlSocketPath)
        try comapeoServer.start()
        try stateServer.start()
        defer {
            comapeoServer.stop()
            stateServer.stop()
        }

        // Accept state IPC connection (service connects to this on start)
        let stateClientFd = stateServer.acceptClient()
        XCTAssertGreaterThanOrEqual(stateClientFd, 0, "State server should accept connection")
        defer { if stateClientFd >= 0 { close(stateClientFd) } }

        // Create app-level IPC (like ComapeoCoreModule would)
        let responseReceived = expectation(description: "Response received from mock server")
        let testResponse = #"{"type":"response","data":"hello from node"}"#

        let appIPC = NodeJSIPC(socketPath: service.comapeoSocketPath) { message in
            XCTAssertEqual(message, testResponse)
            responseReceived.fulfill()
        }

        // Accept comapeo IPC connection
        let comapeoClientFd = comapeoServer.acceptClient()
        XCTAssertGreaterThanOrEqual(comapeoClientFd, 0, "Comapeo server should accept connection")
        defer { if comapeoClientFd >= 0 { close(comapeoClientFd) } }

        waitUntil("appIPC should reach .connected", appIPC.state == .connected)

        // App sends a message
        let testRequest = #"{"type":"request","id":1}"#
        appIPC.sendMessage(testRequest)

        // Mock server receives the request
        let receivedRequest = MockNodeServer.receiveFramedMessage(fd: comapeoClientFd)
        XCTAssertEqual(receivedRequest, testRequest, "Mock server should receive the request")

        // Mock server sends response back
        MockNodeServer.sendFramedMessage(fd: comapeoClientFd, message: testResponse)

        waitForExpectations(timeout: 5)

        // Cleanup
        appIPC.disconnect()
        signalNodeExit()
        service.cleanup()
    }

    /// Tests that shutdown sends the correct message through the state IPC
    /// and transitions to stopped — exercising the full stop flow end-to-end.
    func testGracefulShutdownFlow() throws {
        let service = makeTestService()

        // Start service first so deleteSocketFiles() runs before servers are created
        let started = expectation(description: "Service started")
        service.onStateChange = { if $0 == .started { started.fulfill() } }
        service.start()
        waitForExpectations(timeout: 5)

        let stateServer = MockNodeServer(socketPath: service.controlSocketPath)
        try stateServer.start()
        defer { stateServer.stop() }

        // Accept state IPC connection
        let stateClientFd = stateServer.acceptClient()
        XCTAssertGreaterThanOrEqual(stateClientFd, 0)
        defer { if stateClientFd >= 0 { close(stateClientFd) } }

        // Stop the service asynchronously
        let stopped = expectation(description: "Service stopped")
        DispatchQueue.global().async {
            service.stop(timeout: 3)
            stopped.fulfill()
        }

        // Verify the mock server receives the shutdown message
        let shutdownMsg = MockNodeServer.receiveFramedMessage(fd: stateClientFd)
        XCTAssertEqual(shutdownMsg, #"{"type":"shutdown"}"#, "Should receive shutdown message")

        // Signal mock node to exit so stop() can complete
        signalNodeExit()

        waitForExpectations(timeout: 5)
        XCTAssertEqual(service.state, .stopped)
    }

    /// Tests multiple message exchanges followed by graceful shutdown —
    /// verifying the IPC layer handles sustained traffic before cleanup.
    func testMultipleMessagesBeforeShutdown() throws {
        let service = makeTestService()

        // Start service first so deleteSocketFiles() runs before servers are created
        let started = expectation(description: "Service started")
        service.onStateChange = { if $0 == .started { started.fulfill() } }
        service.start()
        waitForExpectations(timeout: 5)

        let comapeoServer = MockNodeServer(socketPath: service.comapeoSocketPath)
        let stateServer = MockNodeServer(socketPath: service.controlSocketPath)
        try comapeoServer.start()
        try stateServer.start()
        defer {
            comapeoServer.stop()
            stateServer.stop()
        }

        // Accept connections
        let stateClientFd = stateServer.acceptClient()
        defer { if stateClientFd >= 0 { close(stateClientFd) } }

        let messageCount = 5
        let allReceived = expectation(description: "All responses received")
        var receivedMessages = [String]()
        let receiveLock = NSLock()

        let appIPC = NodeJSIPC(socketPath: service.comapeoSocketPath) { message in
            receiveLock.lock()
            receivedMessages.append(message)
            if receivedMessages.count == messageCount {
                allReceived.fulfill()
            }
            receiveLock.unlock()
        }

        let comapeoClientFd = comapeoServer.acceptClient()
        defer { if comapeoClientFd >= 0 { close(comapeoClientFd) } }

        waitUntil("appIPC should reach .connected", appIPC.state == .connected)

        // Echo server on a background thread
        DispatchQueue.global().async {
            for _ in 0..<messageCount {
                if let msg = MockNodeServer.receiveFramedMessage(fd: comapeoClientFd) {
                    MockNodeServer.sendFramedMessage(fd: comapeoClientFd, message: msg)
                }
            }
        }

        // Send multiple messages as fast as possible — the IPC layer is
        // expected to handle this without needing the caller to pace sends.
        for i in 0..<messageCount {
            appIPC.sendMessage(#"{"id":\#(i)}"#)
        }

        waitForExpectations(timeout: 10)

        receiveLock.lock()
        XCTAssertEqual(receivedMessages.count, messageCount)
        receiveLock.unlock()

        // Now shut down
        appIPC.disconnect()
        signalNodeExit()
        service.stop(timeout: 2)
        XCTAssertEqual(service.state, .stopped)
    }

    /// Tests that the service can complete a full start → message → stop → restart cycle.
    func testStartStopRestartCycle() throws {
        for cycle in 1...2 {
            let service = makeTestService()

            let started = expectation(description: "Started cycle \(cycle)")
            service.onStateChange = { if $0 == .started { started.fulfill() } }
            service.start()
            waitForExpectations(timeout: 5)

            // Create mock server after start() so deleteSocketFiles() doesn't remove it
            let comapeoServer = MockNodeServer(socketPath: service.comapeoSocketPath)
            try comapeoServer.start()

            // Send a message through comapeo IPC
            let messageReceived = expectation(description: "Message received cycle \(cycle)")

            let appIPC = NodeJSIPC(socketPath: service.comapeoSocketPath) { message in
                XCTAssertEqual(message, #"{"cycle":\#(cycle)}"#)
                messageReceived.fulfill()
            }

            let clientFd = comapeoServer.acceptClient()
            XCTAssertGreaterThanOrEqual(clientFd, 0)

            waitUntil("appIPC should reach .connected", appIPC.state == .connected)

            // Server sends a message to the app
            MockNodeServer.sendFramedMessage(fd: clientFd, message: #"{"cycle":\#(cycle)}"#)

            waitForExpectations(timeout: 5)

            appIPC.disconnect()
            close(clientFd)
            comapeoServer.stop()
            signalNodeExit()
            service.stop(timeout: 1)

            XCTAssertEqual(service.state, .stopped, "Cycle \(cycle) should end stopped")
        }
    }
}
