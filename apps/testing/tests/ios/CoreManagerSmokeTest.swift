import XCTest
@testable internal import ComapeoCore

/// Phase 1 smoke test: the app builds, loads, and creates a CoMapeo core
/// manager instance.
///
/// Three observable signals correspond to the three claims:
///
///   1. **Builds.** This file compiles and links into the test target. Free —
///      the test running at all is the proof.
///   2. **Loads.** `NodeJSService` reaches `.started`. The same precondition
///      `ServiceLifecycleTest` waits on, but reasserted here so a failure
///      message in the smoke test points at the lifecycle issue directly
///      rather than via the next test in the suite.
///   3. **Creates a core manager.** Backend `index.js` constructs
///      `ComapeoManager` (forcing drizzle migrations, sodium-native dlopen,
///      better-sqlite3 dlopen + DB open) BEFORE it calls
///      `comapeoRpcServer.listen()`. The control server's `ready` broadcast
///      only fires after both `listen()` promises resolve. So observing
///      `ready` on the control socket is sufficient proof that the manager
///      instantiated without error. As a final sanity check we accept-test
///      the comapeo socket.
///
/// Test order: name picks up XCTest's default alphabetic ordering and runs
/// before `ServiceLifecycleTest`, whose terminal phase calls `service.stop()`
/// and burns the once-per-process `NodeMobileStartNode` slot. Do not rename
/// to break that ordering — the precondition assertion at the top of the
/// test will fail loudly if a future change regresses it.
final class CoreManagerSmokeTest: XCTestCase {

    private var service: NodeJSService { AppLifecycleDelegate.nodeService }

    func testAppLoadsAndCreatesCoreManager() throws {
        // Ordering precondition: no prior test should have shut Node down.
        // `.stopped` is fine — it's the legitimate fresh-launch state before
        // applicationDidBecomeActive fires. `.error` means a previous test
        // (or app lifecycle event) tripped the once-per-process guard, in
        // which case the smoke test cannot run. If this fails, check whether
        // a new test was added with a name that sorts before
        // `CoreManagerSmokeTest` and terminates the runtime.
        XCTAssertNotEqual(
            service.state, .error,
            "precondition: service must not be in .error before smoke test"
        )

        // Signal 2: Loads. Drive start if the app's lifecycle didn't already.
        if service.state == .stopped { service.start() }
        let started = expectation(description: "service reaches .started")
        started.assertForOverFulfill = false
        // Install the handler BEFORE checking state. `transitionState(to:)`
        // fires synchronously on the node thread inside `runNode()`, so a
        // check-then-install order can lose the transition between the read
        // and the assignment and then wait the full timeout.
        service.onStateChange = { state in
            if state == .started { started.fulfill() }
        }
        if service.state == .started { started.fulfill() }
        wait(for: [started], timeout: 30)
        XCTAssertEqual(service.state, .started)

        // Signal 3a: control socket emits `ready`. Broadcast happens after
        // backend/index.js's Promise.all([controlIpcServer.listen,
        // comapeoRpcServer.listen]) resolves PLUS a 1 s settle window. The
        // ComapeoManager has been constructed before that point — see
        // backend/index.js:22 (createComapeo) which runs before line 41
        // (comapeoRpcServer.listen).
        let readyReceived = expectation(description: "control IPC saw `ready`")
        readyReceived.assertForOverFulfill = false
        let messagesLock = NSLock()
        var messages: [String] = []

        let controlIPC = NodeJSIPC(socketPath: service.controlSocketPath) { message in
            messagesLock.lock()
            messages.append(message)
            let sawReady = message.contains("ready")
            messagesLock.unlock()
            if sawReady { readyReceived.fulfill() }
        }
        defer { controlIPC.disconnect() }

        // 30 s budget covers cold simulator boot + addon dlopens (sodium-native
        // and better-sqlite3 dominate) + 1 s settle window. On a warm laptop
        // this completes well under 5 s; the wide margin is for CI runners
        // under contention.
        wait(for: [readyReceived], timeout: 30)

        // Signal 3b: comapeo socket actually accepts. If listen() succeeded
        // the file is on disk; this confirms the kernel will let us connect,
        // which would fail if the server had been bound but was already
        // closing. Cheap to do — disconnect cleanly so we don't disturb
        // ServiceLifecycleTest's IPC assertions running after us.
        let comapeoIPC = NodeJSIPC(socketPath: service.comapeoSocketPath) { _ in }
        defer { comapeoIPC.disconnect() }
        waitUntil(
            timeout: 10,
            "comapeo IPC should reach .connected (proves manager + RPC server up)",
            comapeoIPC.state == .connected
        )
        XCTAssertEqual(comapeoIPC.state, .connected)
    }
}
