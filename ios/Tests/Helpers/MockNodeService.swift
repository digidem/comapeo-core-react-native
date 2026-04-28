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

/// Convenience wrapper that also constructs the `NodeJSService` with the mock
/// entry point and a fake JS path. Most tests just need `(service, signalExit)`.
///
/// `privateStorageDir` defaults to a sibling of `filesDir` so callers don't
/// have to thread two paths through every test. Tests that exercise the
/// backend's filesystem state can override it.
func makeMockNodeService(
    filesDir: String,
    privateStorageDir: String? = nil
) -> (service: NodeJSService, signalExit: () -> Void) {
    let (entryPoint, signal) = makeMockNodeEntryPoint()
    let service = NodeJSService(
        filesDir: filesDir,
        privateStorageDir: privateStorageDir
            ?? (filesDir as NSString).appendingPathComponent("private-storage"),
        nodeEntryPoint: entryPoint,
        resolveJSEntryPoint: { "/fake/index.mjs" }
    )
    return (service, signal)
}
