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
    let nodeService = NodeJSService()

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
