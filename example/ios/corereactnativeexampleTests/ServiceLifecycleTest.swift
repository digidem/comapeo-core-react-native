import XCTest
@testable import ComapeoCore

/// Integration tests for NodeJSService lifecycle using the real JS runtime.
/// These tests verify behavior (start/stop/IPC) not implementation details,
/// so they remain valid if the JS runtime is swapped (e.g. to Hermes or BareJS).
final class ServiceLifecycleTest: XCTestCase {
    private var service: NodeJSService!

    override func setUp() {
        super.setUp()
        service = AppLifecycleDelegate.shared.nodeService
        if service.state != .stopped {
            service.stop(timeout: 10)
        }
    }

    override func tearDown() {
        if service.state != .stopped {
            service.stop(timeout: 10)
        }
        super.tearDown()
    }

    func testServiceStartsAndReachesStartedState() {
        let started = expectation(description: "started")
        service.onStateChange = { if $0 == .started { started.fulfill() } }
        service.start()
        waitForExpectations(timeout: 15)
        XCTAssertEqual(service.state, .started)
    }

    func testServiceStopsGracefully() {
        let started = expectation(description: "started")
        service.onStateChange = { if $0 == .started { started.fulfill() } }
        service.start()
        waitForExpectations(timeout: 15)

        service.stop(timeout: 10)
        XCTAssertEqual(service.state, .stopped)
    }

    func testStopThenRestartWorks() {
        let started1 = expectation(description: "started1")
        service.onStateChange = { if $0 == .started { started1.fulfill() } }
        service.start()
        waitForExpectations(timeout: 15)
        service.stop(timeout: 10)
        XCTAssertEqual(service.state, .stopped)

        let started2 = expectation(description: "started2")
        service.onStateChange = { if $0 == .started { started2.fulfill() } }
        service.start()
        waitForExpectations(timeout: 15)
        XCTAssertEqual(service.state, .started)
    }

    func testDoubleStartIsIdempotent() {
        let started = expectation(description: "started")
        service.onStateChange = { if $0 == .started { started.fulfill() } }
        service.start()
        waitForExpectations(timeout: 15)

        service.start()
        Thread.sleep(forTimeInterval: 2)
        XCTAssertEqual(service.state, .started)
    }
}
