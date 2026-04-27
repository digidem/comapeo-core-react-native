import ExpoModulesCore
import UIKit

/// Expo lifecycle delegate that manages the Node.js service in response to
/// iOS application lifecycle events.
///
/// `NodeMobileStartNode` can only be called once per process, so the service
/// cannot be stopped on background and then restarted on foreground. Instead,
/// Node.js keeps running across background/foreground transitions; iOS may
/// suspend or kill the process during long background windows, at which point
/// the next foreground is a fresh process with a fresh single-use slot. The
/// only graceful-shutdown hook is `applicationWillTerminate`.
public class AppLifecycleDelegate: ExpoAppDelegateSubscriber {
    static let shared = AppLifecycleDelegate()

    /// Single shared NodeJSService used by all AppLifecycleDelegate instances.
    /// Expo's module system creates its own instance while tests access `shared`,
    /// so the service must be static to avoid dual-instance conflicts
    /// (NodeMobileStartNode can only be called once per process).
    // Use /tmp for socket files to stay within the 104-byte sockaddr_un.sun_path
    // limit. The app's Documents/tmp directory can exceed this on iOS simulators.
    // On real iOS devices, /tmp is sandboxed to the app's container.
    private static let _nodeService = NodeJSService(
        filesDir: "/tmp/comapeo",
        nodeEntryPoint: { arguments in
            let cStrings = arguments.map { strdup($0)! }
            defer { cStrings.forEach { free($0) } }

            var argv: [UnsafePointer<CChar>?] = cStrings.map { UnsafePointer($0) }
            return argv.withUnsafeMutableBufferPointer { buffer -> Int32 in
                return NodeMobileStartNode(Int32(arguments.count), buffer.baseAddress!)
            }
        },
        resolveJSEntryPoint: {
            Bundle.main.path(forResource: "index", ofType: "js", inDirectory: "nodejs-project")
        }
    )

    /// Static accessor for the shared service. Use this from any non-main-thread
    /// context (e.g. inside `ComapeoCoreModule`'s `OnCreate`, which Expo runs on
    /// the React Native JS thread). Going through `.shared` would force lazy
    /// init of `AppLifecycleDelegate`, whose superclass `BaseExpoAppDelegateSubscriber`
    /// is `@MainActor`-isolated in Expo 55 — Swift 6's runtime check then traps
    /// (SIGTRAP via `_swift_task_checkIsolatedSwift`) when init runs off-main.
    static var nodeService: NodeJSService { _nodeService }

    /// Instance-level accessor kept for tests, which run on the main thread and
    /// therefore can safely materialise `.shared` without tripping the actor
    /// isolation check.
    var nodeService: NodeJSService { Self._nodeService }

    public func applicationDidBecomeActive(_ application: UIApplication) {
        log("applicationDidBecomeActive")
        // Start is guarded by `state == .stopped`, so subsequent foreground
        // transitions in the same process are no-ops.
        nodeService.start()
    }

    public func applicationWillResignActive(_ application: UIApplication) {
        log("applicationWillResignActive")
    }

    public func applicationDidEnterBackground(_ application: UIApplication) {
        log("applicationDidEnterBackground — Node.js continues running")
        // Deliberately do NOT stop Node on background: NodeMobileStartNode
        // is once-per-process, so stopping here would permanently break the
        // app on the next foreground. iOS may suspend or terminate the
        // process during long background windows; when that happens the
        // next launch is a fresh process.
    }

    public func applicationWillTerminate(_ application: UIApplication) {
        log("applicationWillTerminate — stopping Node.js")
        // Final graceful-shutdown hook. Synchronous with a short timeout
        // since termination is imminent.
        nodeService.stop(timeout: 5)
    }
}
