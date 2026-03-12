import XCTest
@testable import ComapeoCore

/// Tests IPC communication with the real JS runtime.
/// Verifies that the state IPC channel works end-to-end by connecting
/// to the state socket and receiving messages from Node.js.
final class IPCIntegrationTest: XCTestCase {
    private var service: NodeJSService!

    override func setUp() {
        super.setUp()
        service = AppLifecycleDelegate.shared.nodeService
        if service.state != .stopped {
            service.stop(timeout: 10)
        }
        let started = expectation(description: "started")
        service.onStateChange = { if $0 == .started { started.fulfill() } }
        service.start()
        waitForExpectations(timeout: 15)
    }

    override func tearDown() {
        if service.state != .stopped {
            service.stop(timeout: 10)
        }
        super.tearDown()
    }

    func testGracefulShutdownSendsMessage() {
        // The fact that stop() completes (rather than timing out) proves
        // that the shutdown message was sent via state IPC and processed
        // by Node.js, which then exited cleanly.
        XCTAssertEqual(service.state, .started)
        service.stop(timeout: 10)
        XCTAssertEqual(service.state, .stopped)
    }

    func testStateIPCReceivesMessages() {
        // Connect a second client to the state socket and verify we receive
        // messages from the Node.js process.
        let messageReceived = expectation(description: "message received")
        let ipc = NodeJSIPC(socketPath: service.stateSocketPath) { message in
            // Node.js sends {"type":"started"} or {"type":"ready"} to new clients
            messageReceived.fulfill()
        }
        defer { ipc.disconnect() }

        waitForExpectations(timeout: 10)
    }
}
