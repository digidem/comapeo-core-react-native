import XCTest
@testable internal import ComapeoCore

/// Unit tests for the `ComapeoCoreModule` static testable seams.
///
/// These tests assert two invariants that the module's public API depends on:
///   1. `resolveSocketPath()` must return the same path `NodeJSService` binds to.
///      If they diverge, the IPC client connects to a nonexistent socket and
///      every `postMessage` call silently drops.
///   2. `stateString(for:ipc:)` must reflect the `NodeJSService` state — the same
///      source used by the `stateChange` event. If push and pull APIs diverge,
///      JS callers get inconsistent readings during startup races and shutdown.
final class ComapeoCoreModuleTests: XCTestCase {

    func testModuleSocketPathMatchesServicePath() {
        // Use the static accessor directly. Going through `.shared` would
        // re-introduce the off-main-thread `@MainActor`-init regression if a
        // future `async` test, `Task { }`, or `XCTContext.runActivity` block
        // happened to evaluate this expression off the main thread.
        let servicePath = AppLifecycleDelegate.nodeService.comapeoSocketPath
        XCTAssertEqual(
            ComapeoCoreModule.resolveSocketPath(),
            servicePath,
            "Module's IPC client path must equal the path NodeJSService binds to"
        )
    }

    func testStateStringDerivesFromServiceArgumentNotIPC() {
        // Drive a mock service into a non-stopped state. With `ipc: nil`
        // passed in, any correct implementation must derive the string from
        // the service state (matching what the `stateChange` event emits).
        // We assert against `.starting` rather than `.started` because
        // `.started` now requires a control-socket handshake (backend
        // sends `started` → service replies with init frame → backend
        // sends `ready`) that the example-app test target has no scaffold
        // for. The contract under test is "stateString reflects
        // `service.state.rawValue`" — the choice of state is incidental.
        let shortID = UUID().uuidString.prefix(8)
        let testDir = "/tmp/cms-module-\(shortID)"
        try? FileManager.default.createDirectory(atPath: testDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: testDir) }

        let semaphore = DispatchSemaphore(value: 0)
        let mockEntry: NodeJSService.NodeEntryPoint = { _ in semaphore.wait(); return 0 }
        let service = NodeJSService(
            socketDir: testDir,
            privateStorageDir: (testDir as NSString).appendingPathComponent("private-storage"),
            nodeEntryPoint: mockEntry,
            resolveJSEntryPoint: { "/fake/index.mjs" },
            rootKeyProvider: { RootKeyResult(key: Data(repeating: 0xAB, count: 16), generated: true) }
        )

        let starting = expectation(description: "mock service reached .starting")
        service.onStateChange = { if $0 == .starting { starting.fulfill() } }
        service.start()
        waitForExpectations(timeout: 5)

        XCTAssertEqual(
            ComapeoCoreModule.stateString(for: service, ipc: nil),
            "STARTING",
            "stateString() must derive from service state, not IPC state"
        )

        // Release the mock entry point and clean up so the test thread exits.
        semaphore.signal()
        service.cleanup()
    }

    func testNotificationPermissionResponseAlwaysGranted() {
        // iOS has no foreground service and no POST_NOTIFICATIONS runtime
        // gate, so both notification AsyncFunctions resolve this fixed
        // response. The shape must stay assignable to the JS
        // `NotificationPermissionResponse` type so host code can treat it
        // interchangeably with Android's expo PermissionResponse.
        let response = ComapeoCoreModule.grantedPermissionResponse

        XCTAssertEqual(response["status"] as? String, "granted")
        XCTAssertEqual(response["granted"] as? Bool, true)
        XCTAssertEqual(response["canAskAgain"] as? Bool, true)
        XCTAssertEqual(response["expires"] as? String, "never")
    }
}
