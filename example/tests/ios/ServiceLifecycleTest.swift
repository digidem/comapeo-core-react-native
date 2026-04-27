import XCTest
import UIKit
@testable import ComapeoCore

/// Integration test for NodeJSService against the real Node.js runtime.
///
/// `NodeMobileStartNode` can only be called once per process, so the whole
/// lifecycle — startup, steady-state assertions, background behaviour, and
/// graceful shutdown — is captured in a single sequential test method. An
/// earlier version of this file split the phases into separate `test01_…`/
/// `test99_…` methods that relied on XCTest's alphabetic test-discovery
/// order to enforce sequencing. That worked but made the ordering dependency
/// invisible and fragile (new tests had to pick a number that fit inside
/// the existing range; renaming silently broke the order).
///
/// Writing the phases as sequential code inside one method makes the
/// once-per-process constraint part of the code itself instead of a naming
/// convention. Per-phase granularity in the Xcode report is preserved via
/// `XCTContext.runActivity` blocks.
final class ServiceLifecycleTest: XCTestCase {

    private var service: NodeJSService {
        AppLifecycleDelegate.shared.nodeService
    }

    /// Waits for the service to reach `.started`. Node may already be started
    /// (the app's `applicationDidBecomeActive` fires on test-host launch) or
    /// still starting when the test begins.
    private func waitForStarted(timeout: TimeInterval = 30) {
        if service.state == .started { return }

        let started = expectation(description: "service started")
        service.onStateChange = { state in
            if state == .started { started.fulfill() }
        }
        // First test in a fresh process may land here before the lifecycle
        // has fired — kick it off explicitly.
        if service.state == .stopped {
            service.start()
        }
        waitForExpectations(timeout: timeout)
    }

    func testFullServiceLifecycle() {
        XCTContext.runActivity(named: "service reaches .started") { _ in
            waitForStarted()
            XCTAssertEqual(service.state, .started)
        }

        XCTContext.runActivity(named: "double start is idempotent") { _ in
            // Capture any transitions that fire after the second start() call.
            // The state machine is synchronous, so an errant transition would
            // already have landed by the time `start()` returns; the brief
            // waitUntil window is a safety margin against hypothetical async
            // observers, not a load-bearing wait.
            var transitions: [NodeJSService.State] = []
            let previous = service.onStateChange
            service.onStateChange = { transitions.append($0) }
            defer { service.onStateChange = previous }

            service.start() // should be a no-op
            waitUntil(timeout: 0.3, "state should stay .started", service.state == .started)
            XCTAssertEqual(service.state, .started)
            XCTAssertTrue(
                transitions.isEmpty,
                "second start() must not emit transitions; got \(transitions)"
            )
        }

        XCTContext.runActivity(named: "state socket is listening") { _ in
            let ipc = NodeJSIPC(socketPath: service.stateSocketPath) { _ in }
            defer { ipc.disconnect() }
            waitUntil(timeout: 15, "IPC should reach .connected", ipc.state == .connected)
            XCTAssertEqual(ipc.state, .connected)
        }

        // Regression: late-connecting state-IPC clients must still receive
        // `started`/`ready`. The Node-side code used to emit these one-shot
        // inside `Promise.all(...).then()`, so any client that finished
        // `waitForFile()` + retry-connect after that point got nothing.
        // Fixed in commit b3634de.
        XCTContext.runActivity(named: "late state-IPC receives started/ready") { _ in
            // Deliberate sleep, not a poll: the test's premise is that we
            // connect *after* Node has already broadcast started/ready. Node
            // resolves its Promise.all and waits 1 s before posting `ready`,
            // so 2 s ensures we're past that window. There's no observable
            // condition that means "Node has finished broadcasting" without
            // racing the very thing we're trying to test.
            Thread.sleep(forTimeInterval: 2)

            let received = expectation(description: "state IPC received started/ready")
            // A late client may see both `started` and `ready` replayed in
            // quick succession — don't fail on over-fulfilment.
            received.assertForOverFulfill = false
            var messages: [String] = []
            let messagesLock = NSLock()

            let ipc = NodeJSIPC(socketPath: service.stateSocketPath) { message in
                messagesLock.lock()
                messages.append(message)
                messagesLock.unlock()
                received.fulfill()
            }
            defer { ipc.disconnect() }

            wait(for: [received], timeout: 10)

            messagesLock.lock()
            let final = messages
            messagesLock.unlock()

            XCTAssertTrue(
                final.contains(where: { $0.contains("started") || $0.contains("ready") }),
                "Late-connecting state IPC must receive started/ready notification; got: \(final)"
            )
        }

        // Regression: backgrounding must not stop Node, since `NodeMobileStartNode`
        // is once-per-process. An earlier version called `stopWithBackgroundTask`
        // from `applicationDidEnterBackground`, which permanently broke the app
        // on the next foreground. Fixed in commit ba9edbe.
        XCTContext.runActivity(named: "background transition does not stop Node") { _ in
            XCTAssertEqual(service.state, .started, "precondition: service is started")

            AppLifecycleDelegate.shared.applicationDidEnterBackground(UIApplication.shared)

            // Negative assertion: state must STAY .started. Poll for ~4 s
            // (longer than the previous bug's async-stop window) and fail
            // fast if it ever transitions away. A fixed sleep would only
            // catch the bug at the end; this catches it the moment it
            // happens, with a clearer failure point.
            let deadline = Date().addingTimeInterval(4)
            while Date() < deadline {
                XCTAssertEqual(
                    service.state, .started,
                    "Background transition must not stop Node (nodejs-mobile once-per-process constraint)"
                )
                if service.state != .started { return }
                Thread.sleep(forTimeInterval: 0.1)
            }
        }

        // Terminal phase — after this, Node cannot be restarted in this
        // process. Must remain last.
        XCTContext.runActivity(named: "graceful shutdown stops service") { _ in
            XCTAssertEqual(service.state, .started, "precondition: still started before shutdown")
            service.stop(timeout: 10)
            XCTAssertEqual(service.state, .stopped)
        }
    }
}
