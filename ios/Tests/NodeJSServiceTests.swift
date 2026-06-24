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
    /// don't have to repeat `socketDir: testDir`.
    private func makeTestService() -> (service: NodeJSService, signalExit: () -> Void) {
        return makeMockNodeService(socketDir: testDir)
    }

    // MARK: - Per-component lifecycle tests
    //
    // These exercise the previously-broken paths the per-component
    // model addresses: an unexpected node exit (without an `error`
    // frame) must derive to ERROR, and a `stopping` frame from the
    // backend must derive to STOPPING before disconnect. The pure
    // `deriveState` table is covered separately in `DeriveStateTests`.

    /// The runtime exits while we're STARTED and stop() was never
    /// called (and the backend never sent `stopping`). Old behavior:
    /// state stayed `.started` until a later cleanup() forced
    /// `.stopped`. New behavior: derives to ERROR with phase
    /// `node-runtime-unexpected`.
    func testUnexpectedNodeExitDerivesError() throws {
        let (service, signalExit) = makeTestService()
        let startedExpectation = expectation(description: "Reached started")
        let errorExpectation = expectation(description: "Derived to error")

        service.onStateChange = { state in
            if state == .started { startedExpectation.fulfill() }
            if state == .error { errorExpectation.fulfill() }
        }

        let backend = try startServiceWithMockBackend(service)
        defer { backend.stop() }
        wait(for: [startedExpectation], timeout: 5)

        // Cause the runtime to exit WITHOUT calling stop() or
        // sending a `stopping` frame — i.e. a crash from the
        // service's perspective.
        signalExit()

        wait(for: [errorExpectation], timeout: 5)
        XCTAssertEqual(service.state, .error)
        let lastError = service.getLastError()
        XCTAssertEqual(lastError?.phase, "node-runtime-unexpected")
        XCTAssertNotNil(lastError?.message)
        // Once in ERROR, start()/stop() are refused.
        service.start()
        XCTAssertEqual(service.state, .error)
    }

    /// Native-local rootkey load failure during the boot handshake.
    /// `rootKeyProvider` throws → `sendInitFrame()` sets
    /// `backendState = .error(rootkey, ...)` → derives ERROR with phase
    /// `rootkey` and the thrown error's localizedDescription as message.
    /// This is a mirror on iOS of the FGS-side rootkey path on Android;
    /// without this test the iOS-only branch of the §5.5 §1 (Errors) doc
    /// section is unverified end-to-end.
    func testRootKeyLoadFailureDerivesError() throws {
        struct RootKeyError: Error, LocalizedError {
            var errorDescription: String? { "test rootkey unavailable" }
        }
        let (service, _) = makeMockNodeService(
            socketDir: testDir,
            rootKeyProvider: { throw RootKeyError() }
        )
        let errorExpectation = expectation(description: "Derived to error")
        service.onStateChange = { if $0 == .error { errorExpectation.fulfill() } }

        let backend = try startServiceWithMockBackend(service)
        defer { backend.stop() }
        wait(for: [errorExpectation], timeout: 5)

        XCTAssertEqual(service.state, .error)
        let lastError = service.getLastError()
        XCTAssertEqual(lastError?.phase, "rootkey")
        XCTAssertEqual(lastError?.message, "test rootkey unavailable")
    }

    /// Backend sends an `error` frame post-`ready`. The service should
    /// transition from STARTED to ERROR carrying the frame's phase and
    /// message. Verifies the §5.5 §2 path (backend-reported failures
    /// reach native via the control socket) end-to-end, not just at the
    /// `ControlFrame.parse` level.
    func testBackendErrorFrameDerivesError() throws {
        let (service, _) = makeTestService()
        let startedExpectation = expectation(description: "Reached started")
        let errorExpectation = expectation(description: "Derived to error")
        service.onStateChange = { state in
            if state == .started { startedExpectation.fulfill() }
            if state == .error { errorExpectation.fulfill() }
        }
        let backend = try startServiceWithMockBackend(service)
        defer { backend.stop() }
        wait(for: [startedExpectation], timeout: 5)

        XCTAssertTrue(
            backend.sendFrame(
                #"{"type":"error","phase":"runtime","message":"backend exploded"}"#
            ),
            "backend client should be connected after handshake"
        )
        wait(for: [errorExpectation], timeout: 5)

        XCTAssertEqual(service.state, .error)
        let lastError = service.getLastError()
        XCTAssertEqual(lastError?.phase, "runtime")
        XCTAssertEqual(lastError?.message, "backend exploded")
    }

    /// Backend sends `{type:"stopping"}` before closing. The service
    /// should derive to STOPPING in response to the frame, then to
    /// STOPPED once the runtime exits.
    func testStoppingFrameDerivesStopping() throws {
        let (service, signalExit) = makeTestService()
        let startedExpectation = expectation(description: "Reached started")
        let stoppingExpectation = expectation(description: "Derived to stopping")
        let stoppedExpectation = expectation(description: "Derived to stopped")

        service.onStateChange = { state in
            if state == .started { startedExpectation.fulfill() }
            if state == .stopping { stoppingExpectation.fulfill() }
            if state == .stopped { stoppedExpectation.fulfill() }
        }

        let backend = try startServiceWithMockBackend(service)
        defer { backend.stop() }
        wait(for: [startedExpectation], timeout: 5)

        // Drive a stop, which causes the MockBackend to send `stopping`
        // before closing the connection. The state path is
        // STARTED → STOPPING → STOPPED.
        DispatchQueue.global().async {
            service.stop(timeout: 3)
        }
        wait(for: [stoppingExpectation], timeout: 5)
        signalExit()
        wait(for: [stoppedExpectation], timeout: 5)
        XCTAssertEqual(service.state, .stopped)
    }

    // MARK: - Startup Tests

    func testStartTransitionsToStarted() throws {
        let (service, signalExit) = makeTestService()
        let startedExpectation = expectation(description: "State reached STARTED")

        service.onStateChange = { state in
            if state == .started {
                startedExpectation.fulfill()
            }
        }

        let backend = try startServiceWithMockBackend(service)
        defer { backend.stop() }
        waitForExpectations(timeout: 5)

        XCTAssertEqual(service.state, .started)
        // Sanity-check the rootkey actually round-tripped through the
        // handshake. `mockTestRootKey` is the shared test vector.
        XCTAssertEqual(backend.receivedRootKey, mockTestRootKey)
        signalExit()
        service.cleanup()
    }

    /// Covers the `.started → start()` no-op path. The other non-stopped
    /// states have their own coverage: `.error` in `testStartFromErrorStateIsRejected`;
    /// `.starting` and `.stopping` are transient and not directly observable
    /// without racy test plumbing, so they're covered by the internal
    /// `guard state == .stopped` in `NodeJSService.start()`.
    func testSecondStartFromStartedIsIgnored() throws {
        let (service, signalExit) = makeTestService()
        let startedExpectation = expectation(description: "State reached STARTED")

        service.onStateChange = { state in
            if state == .started {
                startedExpectation.fulfill()
            }
        }

        let backend = try startServiceWithMockBackend(service)
        defer { backend.stop() }
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
        let stoppingExpectation = expectation(description: "State reached STOPPING")
        service.onStateChange = { state in
            if state == .started {
                startedExpectation.fulfill()
            } else if state == .stopping {
                stoppingExpectation.fulfill()
            }
        }

        // The handshake-driving MockBackend keeps reading after `ready`,
        // so the shutdown frame the service sends on stop() lands on its
        // post-handshake read loop and is captured in `receivedShutdown`.
        let backend = try startServiceWithMockBackend(service)
        defer { backend.stop() }
        wait(for: [startedExpectation], timeout: 5)

        // Stop the service on a background thread (stop() blocks waiting
        // on the node thread to exit).
        let stopFinished = expectation(description: "stop() returned")
        DispatchQueue.global().async {
            service.stop(timeout: 2)
            stopFinished.fulfill()
        }

        // Wait for stop() to set stopRequested (observable via the STOPPING
        // transition) before signalling the mock node to exit. Otherwise
        // the bg dispatch can be scheduled late enough that the runtime
        // exits while stopRequested is still false, making the exit look
        // Unexpected and landing the service in .error.
        wait(for: [stoppingExpectation], timeout: 5)

        // stop() sends the shutdown frame before it blocks on node exit, so wait until the
        // backend's background read loop has actually observed it — before signalling exit.
        // Reading backend.receivedShutdown directly (after stop() returned) raced that loop.
        XCTAssertTrue(
            backend.waitForShutdown(timeout: 5),
            "MockBackend should observe the shutdown frame on the control socket"
        )

        // Signal the mock node process to exit so stop() can complete.
        signalExit()

        wait(for: [stopFinished], timeout: 5)
        XCTAssertEqual(service.state, .stopped)
    }

    func testStopTransitionsToStopped() throws {
        let (service, signalExit) = makeTestService()
        let startedExpectation = expectation(description: "Started")

        service.onStateChange = { state in
            if state == .started { startedExpectation.fulfill() }
        }

        let backend = try startServiceWithMockBackend(service)
        defer { backend.stop() }
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

    func testStopCompletesQuicklyWhenNodeResponds() throws {
        let (service, signalExit) = makeTestService()
        let startedExpectation = expectation(description: "Started")

        service.onStateChange = { state in
            if state == .started { startedExpectation.fulfill() }
        }

        let backend = try startServiceWithMockBackend(service)
        defer { backend.stop() }
        waitForExpectations(timeout: 5)

        // Signal exit immediately so stop() completes quickly
        signalExit()

        let startTime = Date()
        service.stop(timeout: 5)
        let elapsed = Date().timeIntervalSince(startTime)

        XCTAssertLessThan(elapsed, 2, "Stop should complete quickly when node thread responds")
        XCTAssertEqual(service.state, .stopped)
    }

    func testSocketFilesDeletedAfterStop() throws {
        let (service, signalExit) = makeTestService()
        let startedExpectation = expectation(description: "Started")

        service.onStateChange = { state in
            if state == .started { startedExpectation.fulfill() }
        }

        let backend = try startServiceWithMockBackend(service)
        defer { backend.stop() }
        waitForExpectations(timeout: 5)

        signalExit()
        service.stop(timeout: 1)

        let fm = FileManager.default
        XCTAssertFalse(fm.fileExists(atPath: service.comapeoSocketPath), "comapeo.sock should be deleted")
        XCTAssertFalse(fm.fileExists(atPath: service.controlSocketPath), "control.sock should be deleted")
    }

    // MARK: - Cleanup Tests

    func testCleanupIsIdempotent() throws {
        let (service, signalExit) = makeTestService()
        let startedExpectation = expectation(description: "Started")

        service.onStateChange = { state in
            if state == .started { startedExpectation.fulfill() }
        }

        let backend = try startServiceWithMockBackend(service)
        defer { backend.stop() }
        waitForExpectations(timeout: 5)

        signalExit()

        // Call cleanup twice — should not crash or cause issues
        service.cleanup()
        service.cleanup()

        XCTAssertEqual(service.state, .stopped)
    }

    func testCleanupDirectlyFromStarted() throws {
        // cleanup() with the default threadExited: true argument represents a
        // caller that knows the node thread has finished. State lands in .stopped.
        let (service, _) = makeTestService()
        let startedExpectation = expectation(description: "Started")

        service.onStateChange = { state in
            if state == .started { startedExpectation.fulfill() }
        }

        let backend = try startServiceWithMockBackend(service)
        defer { backend.stop() }
        waitForExpectations(timeout: 5)

        // cleanup() without stop() — as the background task expiration handler would do
        service.cleanup()

        XCTAssertEqual(service.state, .stopped)
    }

    // MARK: - Restart Tests

    func testCanRestartAfterStop() throws {
        let (service1, signalExit1) = makeTestService()

        // First cycle
        let started1 = expectation(description: "Started first time")
        service1.onStateChange = { state in
            if state == .started { started1.fulfill() }
        }
        let backend1 = try startServiceWithMockBackend(service1)
        wait(for: [started1], timeout: 5)
        signalExit1()
        service1.stop(timeout: 1)
        backend1.stop()
        XCTAssertEqual(service1.state, .stopped)

        // Second cycle — need a new service since node can only start once per process
        // (but in tests with mocks, we can reuse)
        let (service2, signalExit2) = makeTestService()
        let started2 = expectation(description: "Started second time")
        service2.onStateChange = { state in
            if state == .started { started2.fulfill() }
        }
        let backend2 = try startServiceWithMockBackend(service2)
        defer { backend2.stop() }
        wait(for: [started2], timeout: 5)
        XCTAssertEqual(service2.state, .started)
        signalExit2()
        service2.cleanup()
    }

    // MARK: - Concurrency Tests

    func testConcurrentStopCallsAreSafe() throws {
        let (service, signalExit) = makeTestService()
        let startedExpectation = expectation(description: "Started")
        let stoppingExpectation = expectation(description: "Reached stopping")

        service.onStateChange = { state in
            if state == .started { startedExpectation.fulfill() }
            if state == .stopping { stoppingExpectation.fulfill() }
        }

        let backend = try startServiceWithMockBackend(service)
        defer { backend.stop() }
        wait(for: [startedExpectation], timeout: 5)

        let group = DispatchGroup()

        // Fire 3 concurrent stop() calls. The first to mark intent
        // wins the STOPPED → STOPPING derivation; subsequent calls
        // see state != .started/.starting and bail out cleanly.
        for _ in 0..<3 {
            group.enter()
            DispatchQueue.global().async {
                service.stop(timeout: 1)
                group.leave()
            }
        }

        // Wait until at least one stop() has set stopRequested=true
        // (driving the derivation to .stopping). Without this, the
        // mock entryPoint's exit can race ahead of stop() and the
        // exit-classification correctly flags the runtime exit as
        // unexpected — which is the new model's whole point. The
        // graceful-shutdown path requires intent set BEFORE exit.
        wait(for: [stoppingExpectation], timeout: 5)

        // Now signal the entryPoint to return — exit is classified
        // as requested because stopRequested is already true.
        signalExit()

        let result = group.wait(timeout: .now() + 5)
        XCTAssertEqual(result, .success, "All stop calls should complete")
        XCTAssertEqual(service.state, .stopped)
    }

    // MARK: - Timeout & Error-state Tests

    /// When `stop(timeout:)` times out, the node thread is still alive. Transitioning
    /// state to `.stopped` would allow `start()` to be called again, violating
    /// nodejs-mobile's once-per-process constraint. The service must transition to
    /// `.error` instead.
    ///
    /// Incidentally exercises the state-IPC-still-connecting path: the mock service
    /// has no real state socket server, so `controlIPC` never connects. The shutdown
    /// frame `stop()` sends via `sendMessageSync` lands in the IPC's pre-connect
    /// pending list rather than reaching a peer — that's the actual production
    /// failure mode this test guards against.
    func testStopTimeoutTransitionsToErrorNotStopped() throws {
        let (service, _) = makeTestService()
        let startedExpectation = expectation(description: "Started")
        service.onStateChange = { if $0 == .started { startedExpectation.fulfill() } }

        let backend = try startServiceWithMockBackend(service)
        waitForExpectations(timeout: 5)

        // Tear down the backend before stop() so the shutdown frame has no
        // reader — the service's send queues it, the completion semaphore
        // times out because the mock entry never exits, and stop() lands
        // in `.error`.
        backend.stop()
        service.stop(timeout: 0.1)

        XCTAssertEqual(
            service.state, .error,
            "A timed-out stop must transition to .error, not .stopped — the node thread is still alive"
        )
    }

    /// Specifically targets the rapid-start-stop race. `start()` is synchronous,
    /// but the runNode thread's transition to `.started` and the state IPC's
    /// async connect both schedule on background queues. A `stop()` call dispatched
    /// immediately after `start()` lands somewhere in `.starting` or early
    /// `.started`, with the state IPC almost certainly still in `.connecting`.
    /// The service must dispose cleanly — no crash, no hang — and end up in
    /// `.error` (since the mock entry never exits).
    func testRapidStopAfterStartIsSafe() {
        let (service, _) = makeTestService()

        let stopReturned = expectation(description: "stop returned")
        service.start()
        DispatchQueue.global().async {
            // Tiny head-start to vary the race window a bit; without it, stop
            // often runs before runNode has even scheduled.
            usleep(200) // 0.2 ms
            service.stop(timeout: 0.2)
            stopReturned.fulfill()
        }
        wait(for: [stopReturned], timeout: 5)

        XCTAssertEqual(
            service.state, .error,
            "rapid stop after start must dispose cleanly and land in .error; got \(service.state)"
        )
    }

    /// After a timed-out stop has pushed the service into `.error`, subsequent
    /// `start()` calls must be rejected. Allowing a restart would invoke
    /// `NodeMobileStartNode` a second time in the same process.
    func testStartFromErrorStateIsRejected() throws {
        let (service, _) = makeTestService()
        let startedExpectation = expectation(description: "Started")
        service.onStateChange = { if $0 == .started { startedExpectation.fulfill() } }

        let backend = try startServiceWithMockBackend(service)
        waitForExpectations(timeout: 5)

        // Force transition to .error via timeout path. Tear the backend
        // down first so the shutdown frame has no reader.
        backend.stop()
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

    func testFullLifecycleStateTransitions() throws {
        let (service, signalExit) = makeTestService()
        var transitions = [NodeJSService.State]()
        let lock = NSLock()

        let startedExpectation = expectation(description: "Started")
        let stoppingExpectation = expectation(description: "Stopping")
        service.onStateChange = { state in
            lock.lock()
            transitions.append(state)
            lock.unlock()
            if state == .started { startedExpectation.fulfill() }
            if state == .stopping { stoppingExpectation.fulfill() }
        }

        // Start
        let backend = try startServiceWithMockBackend(service)
        defer { backend.stop() }
        wait(for: [startedExpectation], timeout: 5)

        // Stop the service on a background thread (stop() blocks waiting
        // on the node thread to exit).
        let stopFinished = expectation(description: "stop() returned")
        DispatchQueue.global().async {
            service.stop(timeout: 1)
            stopFinished.fulfill()
        }

        // Wait for the STOPPING observer to fire before signalling the mock
        // node to exit. `applyAndEmit` calls onStateChange outside the
        // service lock (required by testObserverCanReenterLockedMethodFromCallback),
        // so the observer invocation order is not guaranteed to match the
        // underlying state-transition order: a STOPPED callback emitted from
        // the node thread can race ahead of a STOPPING callback emitted from
        // stop() on the main thread, even when the locked transitions
        // themselves ran in the right order. Serialising the test on the
        // STOPPING observer pins the recorded sequence.
        wait(for: [stoppingExpectation], timeout: 5)

        signalExit()
        wait(for: [stopFinished], timeout: 5)

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

    // MARK: - Observer re-entrance

    /// `onStateChange` callbacks must be invoked outside the service's
    /// internal lock. A callback that calls back into a locked method
    /// (here, `cleanup()`) would otherwise deadlock waiting for the lock
    /// the transition is already holding.
    func testObserverCanReenterLockedMethodFromCallback() throws {
        let (service, signalExit) = makeTestService()

        let callbackCompleted = expectation(description: "callback finished without deadlock")

        service.onStateChange = { state in
            // Re-enter a method that takes the service's internal lock from
            // inside the callback. If the callback ran while the lock was
            // held, this would deadlock.
            if state == .started {
                service.cleanup()
                callbackCompleted.fulfill()
            }
        }

        let backend = try startServiceWithMockBackend(service)
        defer { backend.stop() }
        // 5s is generous: the call should return in milliseconds. A
        // deadlock would block here until the timeout.
        wait(for: [callbackCompleted], timeout: 5)

        signalExit()
    }
}
