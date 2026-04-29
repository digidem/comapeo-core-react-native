import XCTest
@testable import ComapeoCore

/// Tests for `JSReloadObserver` and the IPC-disconnect-on-reload contract
/// it provides for `ComapeoCoreModule`.
///
/// Background: on iOS, Expo's `OnDestroy` does not fire when the React
/// Native JS context reloads (expo/expo#33655). The module-side workaround
/// is to subscribe to RN's reload notifications and disconnect the IPC
/// from the notification handler. These tests pin both halves of that:
///
/// 1. `JSReloadObserver` runs its callback synchronously on the posting
///    thread for every notification name it was constructed with, and
///    detaches cleanly on deinit so a leaked instance can't run after
///    its module is gone.
/// 2. When wired to a live `NodeJSIPC` (the same way `ComapeoCoreModule`
///    wires it), posting a reload notification disconnects the IPC and
///    a real socket peer (`MockNodeServer`) observes EOF.
final class JSReloadObserverTests: XCTestCase {

    /// Use a private NotificationCenter so concurrent tests can't
    /// observe each other's posts. Also avoids leaking observers into
    /// `.default` if a test fails before deinit clean-up runs.
    private var center: NotificationCenter!
    private var testDir: String!

    override func setUp() {
        super.setUp()
        center = NotificationCenter()
        testDir = TestPaths.makeShortTempDir(prefix: "rlo")
    }

    override func tearDown() {
        TestPaths.removeTempDir(testDir)
        center = nil
        super.tearDown()
    }

    // MARK: - Unit tests

    func testFiresCallbackForObservedNotification() {
        let name = Notification.Name("test.reload")
        var calls = 0
        let observer = JSReloadObserver(
            notificationNames: [name],
            center: center
        ) {
            calls += 1
        }
        // Keep `observer` alive for the duration of the test (the deinit
        // cleanup is exercised separately below).
        _ = observer

        center.post(name: name, object: nil)
        XCTAssertEqual(calls, 1, "Callback must run exactly once per post")

        center.post(name: name, object: nil)
        XCTAssertEqual(calls, 2, "Subsequent posts must each fire the callback")
    }

    func testIgnoresOtherNotifications() {
        let observed = Notification.Name("test.observed")
        let other = Notification.Name("test.other")
        var calls = 0
        let observer = JSReloadObserver(
            notificationNames: [observed],
            center: center
        ) {
            calls += 1
        }
        _ = observer

        center.post(name: other, object: nil)
        XCTAssertEqual(calls, 0, "Callback must not run for unobserved names")
    }

    func testFiresForAnyOfMultipleNames() {
        let nameA = Notification.Name("test.a")
        let nameB = Notification.Name("test.b")
        var calls = 0
        let observer = JSReloadObserver(
            notificationNames: [nameA, nameB],
            center: center
        ) {
            calls += 1
        }
        _ = observer

        center.post(name: nameA, object: nil)
        center.post(name: nameB, object: nil)
        XCTAssertEqual(
            calls, 2,
            "Each observed name must independently trigger the callback"
        )
    }

    func testDeinitDetachesObserver() {
        let name = Notification.Name("test.deinit")
        var calls = 0
        autoreleasepool {
            let observer = JSReloadObserver(
                notificationNames: [name],
                center: center
            ) {
                calls += 1
            }
            _ = observer
            // Observer goes out of scope at autoreleasepool exit.
        }

        center.post(name: name, object: nil)
        XCTAssertEqual(
            calls, 0,
            "After deinit the observer must no longer fire — otherwise " +
                "leaked module instances on iOS reload would each retain a live " +
                "callback into a torn-down ipc reference."
        )
    }

    func testCallbackRunsOnPostingThread() {
        // Module callers rely on synchronous teardown (ipc.disconnect is
        // synchronous on iOS) so that the backend observes EOF before
        // RN continues with bridge teardown. Confirm the callback isn't
        // hopped to a background queue.
        let name = Notification.Name("test.thread")
        let postingThread = Thread.current
        var callbackThread: Thread?
        let observer = JSReloadObserver(
            notificationNames: [name],
            center: center
        ) {
            callbackThread = Thread.current
        }
        _ = observer

        center.post(name: name, object: nil)
        XCTAssertEqual(
            callbackThread, postingThread,
            "Callback must run on the posting thread (queue: nil)"
        )
    }

    func testDefaultNotificationNamesIncludesReactNativeReloadNames() {
        // Sanity-check the production wiring picks up the names RN
        // actually posts. Hard-coded as strings on purpose (the React-Core
        // header isn't available in the macOS swift-test target).
        let names = JSReloadObserver.defaultNotificationNames.map { $0.rawValue }
        XCTAssertTrue(
            names.contains("RCTBridgeWillReloadNotification"),
            "Old-architecture reload notification must be observed by default"
        )
        XCTAssertTrue(
            names.contains("RCTJavaScriptWillStartLoadingNotification"),
            "Bridgeless / new-architecture reload notification must be observed by default"
        )
    }

    // MARK: - Integration with NodeJSIPC

    /// End-to-end behavioural test for the wiring `ComapeoCoreModule`
    /// installs in `OnCreate`: a `JSReloadObserver` whose callback
    /// disconnects a `NodeJSIPC` connected to a real Unix-domain
    /// socket peer. Posting the reload notification must disconnect the
    /// client and the server must observe EOF on the next read.
    func testReloadNotificationDisconnectsLiveIPC() throws {
        let socketPath = (testDir as NSString).appendingPathComponent("reload.sock")
        let server = MockNodeServer(socketPath: socketPath)
        try server.start()
        defer { server.stop() }

        let ipc = NodeJSIPC(socketPath: socketPath) { _ in }
        let observer = JSReloadObserver(
            notificationNames: [Notification.Name("test.reload")],
            center: center
        ) { [weak ipc] in
            ipc?.disconnect()
        }
        _ = observer

        // Wait for the IPC to reach .connected before posting the
        // notification — otherwise the disconnect races the connect
        // and we can't distinguish "reload caused disconnect" from
        // "connect never landed".
        let serverFd = server.acceptClient()
        XCTAssertGreaterThanOrEqual(serverFd, 0)
        defer { if serverFd >= 0 { close(serverFd) } }
        waitUntil("ipc connects", ipc.state == .connected)

        // Fire the reload notification — same thing
        // RCTBridgeWillReloadNotification would do at runtime.
        center.post(name: Notification.Name("test.reload"), object: nil)

        // Synchronous on iOS: by the time post() returns, disconnect()
        // has run shutdown(2) → join receive → close(2). State must
        // already be .disconnected.
        XCTAssertEqual(
            ipc.state, .disconnected,
            "IPC must be disconnected by the time the notification post returns " +
                "(iOS NodeJSIPC.disconnect is synchronous)"
        )

        // The server end of the socket should now read EOF (0 bytes)
        // — that's the signal the backend's SocketMessagePort uses to
        // emit 'close' and drive rpc-reflector subscription cleanup.
        var byte: UInt8 = 0
        let n = read(serverFd, &byte, 1)
        XCTAssertEqual(
            n, 0,
            "Server-side read must return 0 (EOF) after the client " +
                "disconnects — that's what triggers the backend's per-connection " +
                "rpc-reflector cleanup."
        )
    }
}
