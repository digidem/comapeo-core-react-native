import XCTest
@testable import ComapeoCore

/// Behavioral tests for NodeJSService startup and graceful shutdown.
///
/// These tests use a mock Unix domain socket server (via `MockNodeServer`)
/// to simulate the Node.js process, verifying that:
/// - The service transitions through the correct states
/// - Shutdown sends a `{"type":"shutdown"}` message over the state IPC socket
/// - The service can be restarted after shutdown
/// - Concurrent stop calls are safe
/// - Cleanup is idempotent and safe from any state
///
/// This is the iOS equivalent of testing the Android `ComapeoCoreService` +
/// `NodeJSService` graceful shutdown behavior.
final class NodeJSServiceTests: XCTestCase {

    private var testDir: String!

    override func setUp() {
        super.setUp()
        // Use /tmp with a short prefix to stay within sockaddr_un.sun_path's 104-byte limit.
        let shortID = UUID().uuidString.prefix(8)
        testDir = "/tmp/cms-\(shortID)"
        try? FileManager.default.createDirectory(atPath: testDir, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(atPath: testDir)
        super.tearDown()
    }

    // MARK: - Startup Tests

    func testStartTransitionsToStarted() {
        let service = NodeJSService(filesDir: testDir)
        let startedExpectation = expectation(description: "State reached STARTED")

        service.onStateChange = { state in
            if state == .started {
                startedExpectation.fulfill()
            }
        }

        service.start()
        waitForExpectations(timeout: 5)

        XCTAssertEqual(service.state, .started)
        service.cleanup()
    }

    func testStartFromNonStoppedStateIsIgnored() {
        let service = NodeJSService(filesDir: testDir)
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
        Thread.sleep(forTimeInterval: 0.2)

        XCTAssertTrue(stateChanges.isEmpty, "No state changes should occur on duplicate start")
        XCTAssertEqual(service.state, .started)
        service.cleanup()
    }

    // MARK: - Shutdown Tests

    func testStopSendsShutdownMessageOverIPC() throws {
        let service = NodeJSService(filesDir: testDir)

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

        // Give the IPC connection time to fully establish
        Thread.sleep(forTimeInterval: 0.3)

        // Stop the service on a background thread (stop() blocks)
        DispatchQueue.global().async {
            service.stop(timeout: 2)
        }

        // Read the shutdown message from the mock server side
        let message = MockNodeServer.receiveFramedMessage(fd: clientFd)
        XCTAssertEqual(message, #"{"type":"shutdown"}"#, "Should receive shutdown message")

        // Give stop() time to complete
        Thread.sleep(forTimeInterval: 1)

        XCTAssertEqual(service.state, .stopped)
    }

    func testStopTransitionsToStopped() {
        let service = NodeJSService(filesDir: testDir)
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

        service.stop(timeout: 1)

        XCTAssertEqual(service.state, .stopped)
        XCTAssertTrue(stateSequence.contains(.stopping), "Should transition through STOPPING")
        XCTAssertTrue(stateSequence.contains(.stopped), "Should end at STOPPED")
    }

    func testStopWhenAlreadyStoppedIsIgnored() {
        let service = NodeJSService(filesDir: testDir)
        XCTAssertEqual(service.state, .stopped)

        var stateChanges = [NodeJSService.State]()
        service.onStateChange = { stateChanges.append($0) }

        service.stop(timeout: 0.5)

        XCTAssertTrue(stateChanges.isEmpty, "stop() on stopped service should be a no-op")
        XCTAssertEqual(service.state, .stopped)
    }

    func testStopCompletesQuicklyWhenNodeResponds() {
        let service = NodeJSService(filesDir: testDir)
        let startedExpectation = expectation(description: "Started")

        service.onStateChange = { state in
            if state == .started { startedExpectation.fulfill() }
        }

        service.start()
        waitForExpectations(timeout: 5)

        // With the two-semaphore design, stop() signals the node thread
        // which responds immediately, so stop completes quickly
        let startTime = Date()
        service.stop(timeout: 5)
        let elapsed = Date().timeIntervalSince(startTime)

        XCTAssertLessThan(elapsed, 2, "Stop should complete quickly when node thread responds")
        XCTAssertEqual(service.state, .stopped)
    }

    func testSocketFilesDeletedAfterStop() {
        let service = NodeJSService(filesDir: testDir)
        let startedExpectation = expectation(description: "Started")

        service.onStateChange = { state in
            if state == .started { startedExpectation.fulfill() }
        }

        service.start()
        waitForExpectations(timeout: 5)

        service.stop(timeout: 1)

        let fm = FileManager.default
        XCTAssertFalse(fm.fileExists(atPath: service.comapeoSocketPath), "comapeo.sock should be deleted")
        XCTAssertFalse(fm.fileExists(atPath: service.stateSocketPath), "state.sock should be deleted")
    }

    // MARK: - Cleanup Tests

    func testCleanupIsIdempotent() {
        let service = NodeJSService(filesDir: testDir)
        let startedExpectation = expectation(description: "Started")

        service.onStateChange = { state in
            if state == .started { startedExpectation.fulfill() }
        }

        service.start()
        waitForExpectations(timeout: 5)

        // Call cleanup twice — should not crash or cause issues
        service.cleanup()
        service.cleanup()

        XCTAssertEqual(service.state, .stopped)
    }

    func testCleanupDirectlyFromStarted() {
        // Simulates background task expiration calling cleanup() directly
        let service = NodeJSService(filesDir: testDir)
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
        let service = NodeJSService(filesDir: testDir)

        // First cycle
        let started1 = expectation(description: "Started first time")
        service.onStateChange = { state in
            if state == .started { started1.fulfill() }
        }
        service.start()
        waitForExpectations(timeout: 5)
        service.stop(timeout: 1)
        XCTAssertEqual(service.state, .stopped)

        // Second cycle
        let started2 = expectation(description: "Started second time")
        service.onStateChange = { state in
            if state == .started { started2.fulfill() }
        }
        service.start()
        waitForExpectations(timeout: 5)
        XCTAssertEqual(service.state, .started)
        service.cleanup()
    }

    // MARK: - Concurrency Tests

    func testConcurrentStopCallsAreSafe() {
        let service = NodeJSService(filesDir: testDir)
        let startedExpectation = expectation(description: "Started")

        service.onStateChange = { state in
            if state == .started { startedExpectation.fulfill() }
        }

        service.start()
        waitForExpectations(timeout: 5)

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

    // MARK: - State Transition Order Tests

    func testFullLifecycleStateTransitions() {
        let service = NodeJSService(filesDir: testDir)
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
