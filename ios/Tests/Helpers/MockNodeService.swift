import Foundation
@testable import ComapeoCore

/// Builds a `NodeJSService` wired to a mock node entry point that blocks on a
/// semaphore until signalled.
///
/// Every `NodeJSServiceTests` / `IPCLifecycleTests` case needs the same pair:
/// a service and a "signal exit" closure that unblocks the fake node thread.
/// Keeping this in one place avoids the divergence that was starting to appear
/// between the two test files (one returned a tuple, the other stashed the
/// signal on `self`).
///
/// The returned `signalExit` closure is idempotent-ish: calling it a second
/// time has no effect because `DispatchSemaphore` silently drops over-signals.
/// Tests can therefore call it unconditionally from `tearDown` to guarantee
/// the mock node thread never outlives the test.
func makeMockNodeEntryPoint() -> (entryPoint: NodeJSService.NodeEntryPoint, signal: () -> Void) {
    let semaphore = DispatchSemaphore(value: 0)
    let entryPoint: NodeJSService.NodeEntryPoint = { _ in
        semaphore.wait()
        return 0
    }
    return (entryPoint, { semaphore.signal() })
}

/// A fixed 16-byte test vector used as the rootkey under macOS swift-test
/// runs. Returned by the default `rootKeyProvider` injected via
/// `makeMockNodeService` so tests never touch the real keychain.
let mockTestRootKey = Data(repeating: 0xAB, count: 16)

/// Convenience wrapper that also constructs the `NodeJSService` with the mock
/// entry point and a fake JS path. Most tests just need `(service, signalExit)`.
///
/// `privateStorageDir` defaults to a sibling of `socketDir` so callers don't
/// have to thread two paths through every test. Tests that exercise the
/// backend's filesystem state can override it.
///
/// `rootKeyProvider` defaults to a fixed test vector. Tests that want to
/// exercise the failure path (e.g. simulating a locked keychain) can inject
/// a closure that throws.
func makeMockNodeService(
    socketDir: String,
    privateStorageDir: String? = nil,
    rootKeyProvider: @escaping NodeJSService.RootKeyProvider = {
        RootKeyResult(key: mockTestRootKey, generated: false)
    }
) -> (service: NodeJSService, signalExit: () -> Void) {
    let (entryPoint, signal) = makeMockNodeEntryPoint()
    let service = NodeJSService(
        socketDir: socketDir,
        privateStorageDir: privateStorageDir
            ?? (socketDir as NSString).appendingPathComponent("private-storage"),
        nodeEntryPoint: entryPoint,
        resolveJSEntryPoint: { "/fake/index.mjs" },
        rootKeyProvider: rootKeyProvider
    )
    return (service, signal)
}

/// Boots the service and stands up a `MockBackend` to drive the
/// `started → init → ready` handshake. Returns the backend so the caller can
/// stop it (and inspect post-handshake state) when the test ends.
///
/// Order is load-bearing: `service.start()` calls `deleteSocketFiles()`
/// synchronously, so the backend's `start()` must run AFTER that call —
/// otherwise the bind file gets deleted out from under us.
func startServiceWithMockBackend(_ service: NodeJSService) throws -> MockBackend {
    service.start()
    let backend = MockBackend(controlSocketPath: service.controlSocketPath)
    try backend.start()
    return backend
}
