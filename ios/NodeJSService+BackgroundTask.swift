import Foundation
import UIKit

extension NodeJSService {
    /// Stops the Node.js process within a background task, requesting additional
    /// execution time from iOS.
    func stopWithBackgroundTask(timeout: TimeInterval = 10) {
        var backgroundTaskID: UIBackgroundTaskIdentifier = .invalid

        backgroundTaskID = UIApplication.shared.beginBackgroundTask(withName: "ComapeoGracefulShutdown") {
            // Expiration handler — system is about to kill us
            log("Background task expiring, forcing cleanup")
            self.cleanup()
            if backgroundTaskID != .invalid {
                UIApplication.shared.endBackgroundTask(backgroundTaskID)
                backgroundTaskID = .invalid
            }
        }

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            self?.stop(timeout: timeout)
            if backgroundTaskID != .invalid {
                UIApplication.shared.endBackgroundTask(backgroundTaskID)
                backgroundTaskID = .invalid
            }
        }
    }
}
