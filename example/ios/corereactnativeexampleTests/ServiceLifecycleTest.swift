import XCTest
@testable import ComapeoCore

/// Integration tests for NodeJSService using the real Node.js runtime.
///
/// IMPORTANT: NodeMobileStartNode can only be called once per process,
/// so these tests must NOT stop and restart Node. Tests run alphabetically;
/// the shutdown test is prefixed "test99" to ensure it runs last.
///
/// applicationDidBecomeActive starts Node automatically when the app launches.
/// Tests wait for the service to reach .started state before asserting.
final class ServiceIntegrationTest: XCTestCase {
    private var service: NodeJSService {
        AppLifecycleDelegate.shared.nodeService
    }

    /// Waits for the service to reach .started state.
    /// Node may already be started (via applicationDidBecomeActive) or still starting.
    private func waitForStarted() {
        if service.state == .started { return }

        let started = expectation(description: "service started")
        service.onStateChange = { state in
            if state == .started { started.fulfill() }
        }
        // If it's stopped (e.g. first test in a fresh process where lifecycle hasn't fired),
        // start it now.
        if service.state == .stopped {
            service.start()
        }
        waitForExpectations(timeout: 30)
    }

    // MARK: - Tests (run in alphabetical order)

    func test01_ServiceReachesStartedState() {
        waitForStarted()
        XCTAssertEqual(service.state, .started)
    }

    func test02_DoubleStartIsIdempotent() {
        waitForStarted()
        service.start() // should be a no-op
        Thread.sleep(forTimeInterval: 2)
        XCTAssertEqual(service.state, .started)
    }

    func test03_StateSocketIsListening() {
        waitForStarted()

        // Verify we can connect to the state IPC socket
        let ipc = NodeJSIPC(socketPath: service.stateSocketPath) { _ in }
        defer { ipc.disconnect() }

        // Wait briefly for the async connection to establish
        let connected = expectation(description: "connected")
        DispatchQueue.global().async {
            let deadline = Date().addingTimeInterval(10)
            while ipc.state != .connected && Date() < deadline {
                Thread.sleep(forTimeInterval: 0.1)
            }
            if ipc.state == .connected { connected.fulfill() }
        }
        waitForExpectations(timeout: 15)
        XCTAssertEqual(ipc.state, .connected)
    }

    /// Shutdown test — MUST run last. After this, Node cannot be restarted.
    func test99_GracefulShutdownStopsService() {
        waitForStarted()
        XCTAssertEqual(service.state, .started)
        service.stop(timeout: 10)
        XCTAssertEqual(service.state, .stopped)
    }
}
