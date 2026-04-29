import XCTest
@testable import ComapeoCore

/// Pure unit tests for `NodeJSService.deriveState`. The derivation
/// function is the heart of the per-component lifecycle model — every
/// public state transition lands by computing this function over the
/// (NodeRuntime, BackendState, stopRequested) triple.
///
/// Coverage rationale: behavioural tests like `NodeJSServiceTests`
/// exercise the derivation indirectly via real start/stop flows, but
/// they leave most cells of the truth table untouched. These tests
/// pin the table directly so a regression that flips one cell doesn't
/// have to sneak through a behavioural test that happens to exercise
/// it.
final class DeriveStateTests: XCTestCase {

    // Shorthand to keep the test bodies readable.
    private typealias S = NodeJSService.State
    private typealias N = NodeJSService.NodeRuntimeState
    private typealias B = NodeJSService.BackendState
    private typealias R = NodeJSService.ExitReason

    private func derive(_ n: N, _ b: B, _ stop: Bool = false) -> S {
        return NodeJSService.deriveState(
            nodeRuntime: n, backendState: b, stopRequested: stop
        )
    }

    // MARK: - Rule 1: backend-reported error wins over everything

    func testBackendErrorAlwaysDerivesError() {
        let backendErr = B.error(phase: "construct", message: "boom")
        XCTAssertEqual(derive(.notRunning, backendErr), .error)
        XCTAssertEqual(derive(.running, backendErr), .error)
        XCTAssertEqual(derive(.exited(code: 0, reason: .requested), backendErr), .error)
        XCTAssertEqual(derive(.exited(code: 1, reason: .unexpected), backendErr), .error)
        // Even with stop intent — backend error is louder.
        XCTAssertEqual(derive(.notRunning, backendErr, true), .error)
    }

    // MARK: - Rule 2: unexpected runtime exit derives ERROR

    func testUnexpectedRuntimeExitDerivesError() {
        let exitedUnexpected = N.exited(code: 1, reason: .unexpected)
        // Across the BackendState variants that aren't .error.
        XCTAssertEqual(derive(exitedUnexpected, .unknown), .error)
        XCTAssertEqual(derive(exitedUnexpected, .controlBound), .error)
        XCTAssertEqual(derive(exitedUnexpected, .ready), .error)
        XCTAssertEqual(derive(exitedUnexpected, .stopping), .error)
        // Unexpected exit even outranks stop intent — if the runtime
        // crashed, that's ERROR, not "we wanted it gone so call it stopped".
        XCTAssertEqual(derive(exitedUnexpected, .ready, true), .error)
    }

    // MARK: - Rule 3: stop intent

    func testStopIntentWithRuntimeGoneDerivesStopped() {
        // Runtime not yet started OR cleanly exited — STOPPED.
        XCTAssertEqual(derive(.notRunning, .unknown, true), .stopped)
        XCTAssertEqual(derive(.exited(code: 0, reason: .requested), .ready, true), .stopped)
        XCTAssertEqual(derive(.exited(code: 0, reason: .requested), .stopping, true), .stopped)
    }

    func testStopIntentWithRuntimeStillRunningDerivesStopping() {
        XCTAssertEqual(derive(.running, .ready, true), .stopping)
        XCTAssertEqual(derive(.running, .controlBound, true), .stopping)
        XCTAssertEqual(derive(.running, .stopping, true), .stopping)
    }

    // MARK: - Rule 4: backend stopping

    func testBackendStoppingDerivesStopping() {
        XCTAssertEqual(derive(.running, .stopping), .stopping)
        XCTAssertEqual(derive(.notRunning, .stopping), .stopping)
    }

    // MARK: - Rule 5: ready

    func testBackendReadyDerivesStarted() {
        XCTAssertEqual(derive(.running, .ready), .started)
    }

    // MARK: - Rule 6: starting

    func testRunningOrControlBoundDerivesStarting() {
        XCTAssertEqual(derive(.running, .unknown), .starting)
        XCTAssertEqual(derive(.running, .controlBound), .starting)
        // Edge case: backend bound the control socket but the runtime
        // is somehow not running yet — this shouldn't happen in
        // practice but the derivation is still STARTING (we're in
        // mid-handshake).
        XCTAssertEqual(derive(.notRunning, .controlBound), .starting)
    }

    // MARK: - Rule 7: default → STOPPED

    func testDefaultPathDerivesStopped() {
        XCTAssertEqual(derive(.notRunning, .unknown), .stopped)
        // Requested-exit without stop intent (e.g. backend told us
        // it's stopping, then exited; we never called stop()).
        XCTAssertEqual(derive(.exited(code: 0, reason: .requested), .unknown), .stopped)
    }

    // MARK: - Sanity: STARTED → STOPPING → STOPPED graceful path

    func testGracefulShutdownDerivationSequence() {
        // STARTED: runtime running, backend ready.
        XCTAssertEqual(derive(.running, .ready, false), .started)
        // stop() called → STOPPING (intent + still running).
        XCTAssertEqual(derive(.running, .ready, true), .stopping)
        // Backend acknowledges with stopping frame → still STOPPING.
        XCTAssertEqual(derive(.running, .stopping, true), .stopping)
        // Runtime exits cleanly → STOPPED.
        XCTAssertEqual(
            derive(.exited(code: 0, reason: .requested), .stopping, true),
            .stopped
        )
    }
}
