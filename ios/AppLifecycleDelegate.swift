import ExpoModulesCore
import UIKit

/// Expo lifecycle delegate that manages the Node.js service in response to
/// iOS application lifecycle events.
///
/// iOS does not support foreground services like Android. Instead, when the app
/// enters background, we use `UIApplication.beginBackgroundTask` to request
/// additional execution time and gracefully shut down the Node.js process.
/// When the app returns to foreground, we restart the service.
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

    var nodeService: NodeJSService { Self._nodeService }

    public func applicationDidBecomeActive(_ application: UIApplication) {
        log("applicationDidBecomeActive")
        nodeService.start()
    }

    public func applicationWillResignActive(_ application: UIApplication) {
        log("applicationWillResignActive")
    }

    public func applicationDidEnterBackground(_ application: UIApplication) {
        log("applicationDidEnterBackground — initiating graceful shutdown")
        nodeService.stopWithBackgroundTask(timeout: 10)
    }

    public func applicationWillTerminate(_ application: UIApplication) {
        log("applicationWillTerminate — stopping Node.js")
        // Synchronous stop with short timeout since termination is imminent
        nodeService.stop(timeout: 5)
    }
}
