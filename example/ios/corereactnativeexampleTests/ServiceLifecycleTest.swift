import XCTest
import UIKit
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

    /// Late-connecting state-IPC clients must still receive the `started`
    /// notification. In the current Node-side code, the `started`/`ready`
    /// messages are emitted one-shot inside a `Promise.all(...).then()` which
    /// resolves before any iOS client finishes `waitForFile()` + retry-connect,
    /// so `controlClients` is empty and the messages go nowhere.
    func test05_LateStateIPCReceivesStartedEvent() {
        waitForStarted()
        // Give Node's index.js time to pass its Promise.all resolution and
        // the 1 s delay before posting `ready`, so we are definitively "late".
        Thread.sleep(forTimeInterval: 2)

        let received = expectation(description: "state IPC received a started/ready notification")
        var messages: [String] = []
        let messagesLock = NSLock()

        let ipc = NodeJSIPC(socketPath: service.stateSocketPath) { message in
            messagesLock.lock()
            messages.append(message)
            messagesLock.unlock()
            received.fulfill()
        }
        defer { ipc.disconnect() }

        waitForExpectations(timeout: 10)

        messagesLock.lock()
        let final = messages
        messagesLock.unlock()

        XCTAssertTrue(
            final.contains(where: { $0.contains("started") || $0.contains("ready") }),
            "Late-connecting state IPC must receive started/ready notification; got: \(final)"
        )
    }

    /// Backgrounding the app must not stop Node, because iOS's
    /// `NodeMobileStartNode` can only be called once per process. The current
    /// code stops Node on `applicationDidEnterBackground` via
    /// `stopWithBackgroundTask`; after the first backgrounding, Node cannot
    /// legally be restarted — every normal foreground/background cycle breaks
    /// the app for the rest of the session.
    ///
    /// Runs just before the final shutdown test.
    func test98_BackgroundDoesNotStopNode() {
        waitForStarted()
        XCTAssertEqual(service.state, .started, "precondition: service is started")

        AppLifecycleDelegate.shared.applicationDidEnterBackground(UIApplication.shared)

        // stopWithBackgroundTask dispatches stop() asynchronously with a 10 s
        // timeout. Give it long enough to complete its graceful-shutdown work
        // if it's going to — with the current bug, state ends up in .stopped.
        Thread.sleep(forTimeInterval: 4)

        XCTAssertEqual(
            service.state, .started,
            "Background transition must not stop Node (nodejs-mobile once-per-process constraint)"
        )
    }

    /// Shutdown test — MUST run last. After this, Node cannot be restarted.
    func test99_GracefulShutdownStopsService() {
        waitForStarted()
        XCTAssertEqual(service.state, .started)
        service.stop(timeout: 10)
        XCTAssertEqual(service.state, .stopped)
    }
}
