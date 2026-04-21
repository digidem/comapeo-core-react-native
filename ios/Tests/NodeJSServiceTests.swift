import XCTest
@testable import ComapeoCore

/// Behavioral tests for NodeJSService startup and graceful shutdown.
///
/// These tests use a mock node entry point (a blocking semaphore) to simulate
/// the Node.js process, verifying that:
/// - The service transitions through the correct states
/// - Shutdown sends a `{"type":"shutdown"}` message over the state IPC socket
/// - The service can be restarted after shutdown
/// - Concurrent stop calls are safe
/// - Cleanup is idempotent and safe from any state
///
/// This is the iOS equivalent of testing the Android `ComapeoCoreService` +
/// `NodeJSService` graceful shutdown behavior.
///
/// `testStopTimeoutTransitionsToErrorNotStopped` and
/// `testStartFromErrorStateIsRejected` were introduced as failing tests
/// (commit c665cf6) and now serve as regression tests for the fix in
/// `ba9edbe`/`62f9128` — a timed-out `stop()` must land in `.error` rather
/// than `.stopped`, so nothing tries to call `NodeMobileStartNode` twice
/// in a single process.
final class NodeJSServiceTests: XCTestCase {

    private var testDir: String!

    override func setUp() {
        super.setUp()
        testDir = TestPaths.makeShortTempDir(prefix: "cms")
    }

    override func tearDown() {
        TestPaths.removeTempDir(testDir)
        super.tearDown()
    }

    /// Builds a service wired to a blocking mock node entry point.
    /// Thin wrapper over the shared `makeMockNodeService` helper so callsites
    /// don't have to repeat `filesDir: testDir`.
    private func makeTestService() -> (service: NodeJSService, signalExit: () -> Void) {
        return makeMockNodeService(filesDir: testDir)
    }

    // MARK: - Startup Tests

    func testStartTransitionsToStarted() {
        let (service, signalExit) = makeTestService()
        let startedExpectation = expectation(description: "State reached STARTED")

        service.onStateChange = { state in
            if state == .started {
                startedExpectation.fulfill()
            }
        }

        service.start()
        waitForExpectations(timeout: 5)

        XCTAssertEqual(service.state, .started)
        signalExit()
        service.cleanup()
    }

    /// Covers the `.started → start()` no-op path. The other non-stopped
    /// states have their own coverage: `.error` in `testStartFromErrorStateIsRejected`;
    /// `.starting` and `.stopping` are transient and not directly observable
    /// without racy test plumbing, so they're covered by the internal
    /// `guard state == .stopped` in `NodeJSService.start()`.
    func testSecondStartFromStartedIsIgnored() {
        let (service, signalExit) = makeTestService()
        let startedExpectation = expectation(description: "State reached STARTED")

        service.onStateChange = { state in
            if state == .started {
                startedExpectation.fulfill()
            }
        }

        service.start()
        waitForExpectations(timeout: 5)

        // Second start should be ignored
        var stateChanges = [NodeJSService.State]()
        service.onStateChange = { state in
            stateChanges.append(state)
        }

        service.start()
        // Give any errant state change time to land — shorter than the
        // previous sleep because the state machine is synchronous.
        waitUntil(timeout: 0.1, "state should stay .started", service.state == .started)

        XCTAssertTrue(stateChanges.isEmpty, "No state changes should occur on duplicate start")
        XCTAssertEqual(service.state, .started)
        signalExit()
        service.cleanup()
    }

    // MARK: - Shutdown Tests

    func testStopSendsShutdownMessageOverIPC() throws {
        let (service, signalExit) = makeTestService()

        let startedExpectation = expectation(description: "State reached STARTED")
        service.onStateChange = { state in
            if state == .started {
                startedExpectation.fulfill()
            }
        }

        service.start()
        waitForExpectations(timeout: 5)

        // Create mock state server AFTER start() so deleteSocketFiles() doesn't remove it.
        // The stateIPC is already polling via waitForFile() and will connect once
        // the server creates the socket file.
        let stateServer = MockNodeServer(socketPath: service.stateSocketPath)
        try stateServer.start()
        defer { stateServer.stop() }

        // Accept the IPC client connection from the service
        let clientFd = stateServer.acceptClient()
        XCTAssertGreaterThanOrEqual(clientFd, 0, "Should accept IPC client")
        defer { close(clientFd) }

        // Stop the service on a background thread (stop() blocks)
        let stopFinished = expectation(description: "stop() returned")
        DispatchQueue.global().async {
            service.stop(timeout: 2)
            stopFinished.fulfill()
        }

        // Read the shutdown message from the mock server side
        let message = MockNodeServer.receiveFramedMessage(fd: clientFd)
        XCTAssertEqual(message, #"{"type":"shutdown"}"#, "Should receive shutdown message")

        // Signal the mock node process to exit so stop() can complete.
        signalExit()

        wait(for: [stopFinished], timeout: 5)
        XCTAssertEqual(service.state, .stopped)
    }

    func testStopTransitionsToStopped() {
        let (service, signalExit) = makeTestService()
        let startedExpectation = expectation(description: "Started")

        service.onStateChange = { state in
            if state == .started { startedExpectation.fulfill() }
        }

        service.start()
        waitForExpectations(timeout: 5)

        var stateSequence = [NodeJSService.State]()
        service.onStateChange = { state in
            stateSequence.append(state)
        }

        // Signal exit so stop() completes when it sends shutdown
        signalExit()
        service.stop(timeout: 1)

        XCTAssertEqual(service.state, .stopped)
        XCTAssertTrue(stateSequence.contains(.stopping), "Should transition through STOPPING")
        XCTAssertTrue(stateSequence.contains(.stopped), "Should end at STOPPED")
    }

    func testStopWhenAlreadyStoppedIsIgnored() {
        let (service, _) = makeTestService()
        XCTAssertEqual(service.state, .stopped)

        var stateChanges = [NodeJSService.State]()
        service.onStateChange = { stateChanges.append($0) }

        service.stop(timeout: 0.5)

        XCTAssertTrue(stateChanges.isEmpty, "stop() on stopped service should be a no-op")
        XCTAssertEqual(service.state, .stopped)
    }

    func testStopCompletesQuicklyWhenNodeResponds() {
        let (service, signalExit) = makeTestService()
        let startedExpectation = expectation(description: "Started")

        service.onStateChange = { state in
            if state == .started { startedExpectation.fulfill() }
        }

        service.start()
        waitForExpectations(timeout: 5)

        // Signal exit immediately so stop() completes quickly
        signalExit()

        let startTime = Date()
        service.stop(timeout: 5)
        let elapsed = Date().timeIntervalSince(startTime)

        XCTAssertLessThan(elapsed, 2, "Stop should complete quickly when node thread responds")
        XCTAssertEqual(service.state, .stopped)
    }

    func testSocketFilesDeletedAfterStop() {
        let (service, signalExit) = makeTestService()
        let startedExpectation = expectation(description: "Started")

        service.onStateChange = { state in
            if state == .started { startedExpectation.fulfill() }
        }

        service.start()
        waitForExpectations(timeout: 5)

        signalExit()
        service.stop(timeout: 1)

        let fm = FileManager.default
        XCTAssertFalse(fm.fileExists(atPath: service.comapeoSocketPath), "comapeo.sock should be deleted")
        XCTAssertFalse(fm.fileExists(atPath: service.stateSocketPath), "state.sock should be deleted")
    }

    // MARK: - Cleanup Tests

    func testCleanupIsIdempotent() {
        let (service, signalExit) = makeTestService()
        let startedExpectation = expectation(description: "Started")

        service.onStateChange = { state in
            if state == .started { startedExpectation.fulfill() }
        }

        service.start()
        waitForExpectations(timeout: 5)

        signalExit()

        // Call cleanup twice — should not crash or cause issues
        service.cleanup()
        service.cleanup()

        XCTAssertEqual(service.state, .stopped)
    }

    func testCleanupDirectlyFromStarted() {
        // cleanup() with the default threadExited: true argument represents a
        // caller that knows the node thread has finished. State lands in .stopped.
        let (service, _) = makeTestService()
        let startedExpectation = expectation(description: "Started")

        service.onStateChange = { state in
            if state == .started { startedExpectation.fulfill() }
        }

        service.start()
        waitForExpectations(timeout: 5)

        // cleanup() without stop() — as the background task expiration handler would do
        service.cleanup()

        XCTAssertEqual(service.state, .stopped)
    }

    // MARK: - Restart Tests

    func testCanRestartAfterStop() {
        let (service1, signalExit1) = makeTestService()

        // First cycle
        let started1 = expectation(description: "Started first time")
        service1.onStateChange = { state in
            if state == .started { started1.fulfill() }
        }
        service1.start()
        waitForExpectations(timeout: 5)
        signalExit1()
        service1.stop(timeout: 1)
        XCTAssertEqual(service1.state, .stopped)

        // Second cycle — need a new service since node can only start once per process
        // (but in tests with mocks, we can reuse)
        let (service2, signalExit2) = makeTestService()
        let started2 = expectation(description: "Started second time")
        service2.onStateChange = { state in
            if state == .started { started2.fulfill() }
        }
        service2.start()
        waitForExpectations(timeout: 5)
        XCTAssertEqual(service2.state, .started)
        signalExit2()
        service2.cleanup()
    }

    // MARK: - Concurrency Tests

    func testConcurrentStopCallsAreSafe() {
        let (service, signalExit) = makeTestService()
        let startedExpectation = expectation(description: "Started")

        service.onStateChange = { state in
            if state == .started { startedExpectation.fulfill() }
        }

        service.start()
        waitForExpectations(timeout: 5)

        // Signal exit so stop() calls can complete
        signalExit()

        let group = DispatchGroup()

        // Fire 3 concurrent stop() calls
        for _ in 0..<3 {
            group.enter()
            DispatchQueue.global().async {
                service.stop(timeout: 1)
                group.leave()
            }
        }

        let result = group.wait(timeout: .now() + 5)
        XCTAssertEqual(result, .success, "All stop calls should complete")
        XCTAssertEqual(service.state, .stopped)
    }

    // MARK: - Timeout & Error-state Tests

    /// When `stop(timeout:)` times out, the node thread is still alive. Transitioning
    /// state to `.stopped` would allow `start()` to be called again, violating
    /// nodejs-mobile's once-per-process constraint. The service must transition to
    /// `.error` instead.
    func testStopTimeoutTransitionsToErrorNotStopped() {
        let (service, _) = makeTestService()
        let startedExpectation = expectation(description: "Started")
        service.onStateChange = { if $0 == .started { startedExpectation.fulfill() } }

        service.start()
        waitForExpectations(timeout: 5)

        // The mock entry blocks forever (we never call signalExit). stop() sends
        // a shutdown message that no one reads, so the completion semaphore times out.
        service.stop(timeout: 0.1)

        XCTAssertEqual(
            service.state, .error,
            "A timed-out stop must transition to .error, not .stopped — the node thread is still alive"
        )
    }

    /// After a timed-out stop has pushed the service into `.error`, subsequent
    /// `start()` calls must be rejected. Allowing a restart would invoke
    /// `NodeMobileStartNode` a second time in the same process.
    func testStartFromErrorStateIsRejected() {
        let (service, _) = makeTestService()
        let startedExpectation = expectation(description: "Started")
        service.onStateChange = { if $0 == .started { startedExpectation.fulfill() } }

        service.start()
        waitForExpectations(timeout: 5)

        // Force transition to .error via timeout path.
        service.stop(timeout: 0.1)
        XCTAssertEqual(service.state, .error, "precondition: timed-out stop must land in .error")

        var stateChangesAfterError = [NodeJSService.State]()
        service.onStateChange = { stateChangesAfterError.append($0) }

        service.start()
        // Poll briefly — start() is synchronous, so any change would already
        // have fired by the first poll. We still give it a moment in case the
        // guard itself dispatched something unexpected.
        waitUntil(timeout: 0.1, "state must remain .error", service.state == .error)

        XCTAssertEqual(service.state, .error, "start() from .error must not transition state")
        XCTAssertTrue(
            stateChangesAfterError.isEmpty,
            "start() from .error must not emit any state changes; got: \(stateChangesAfterError)"
        )
    }

    // MARK: - State Transition Order Tests

    func testFullLifecycleStateTransitions() {
        let (service, signalExit) = makeTestService()
        var transitions = [NodeJSService.State]()
        let lock = NSLock()

        let startedExpectation = expectation(description: "Started")
        service.onStateChange = { state in
            lock.lock()
            transitions.append(state)
            lock.unlock()
            if state == .started { startedExpectation.fulfill() }
        }

        // Start
        service.start()
        waitForExpectations(timeout: 5)

        // Stop
        signalExit()
        service.stop(timeout: 1)

        lock.lock()
        let finalTransitions = transitions
        lock.unlock()

        // Verify state transition order
        XCTAssertTrue(finalTransitions.count >= 3, "Should have at least STARTING, STARTED, STOPPING transitions")

        let startingIdx = finalTransitions.firstIndex(of: .starting)
        let startedIdx = finalTransitions.firstIndex(of: .started)
        let stoppingIdx = finalTransitions.firstIndex(of: .stopping)
        let stoppedIdx = finalTransitions.firstIndex(of: .stopped)

        XCTAssertNotNil(startingIdx, "Should have STARTING transition")
        XCTAssertNotNil(startedIdx, "Should have STARTED transition")
        XCTAssertNotNil(stoppingIdx, "Should have STOPPING transition")
        XCTAssertNotNil(stoppedIdx, "Should have STOPPED transition")

        if let si = startingIdx, let sa = startedIdx, let sp = stoppingIdx, let sd = stoppedIdx {
            XCTAssertLessThan(si, sa, "STARTING should come before STARTED")
            XCTAssertLessThan(sa, sp, "STARTED should come before STOPPING")
            XCTAssertLessThan(sp, sd, "STOPPING should come before STOPPED")
        }
    }
}
