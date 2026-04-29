import Foundation

/// Observes the NSNotifications React Native posts when the JS runtime is
/// about to be torn down (developer reload, `DevSettings.reload()`,
/// fast-refresh full reload), and runs a caller-supplied closure on each
/// such event.
///
/// Why this exists separately from Expo's `OnDestroy { ... }`:
/// `OnDestroy` does not fire on iOS when the JS context reloads — see
/// [expo/expo#33655](https://github.com/expo/expo/issues/33655). On
/// reload, Expo creates a fresh module instance via `OnCreate` but the
/// previous instance is leaked, with `OnDestroy` never invoked. That
/// leaves any IPC socket the previous instance owned still connected,
/// so the Node.js backend keeps emitting events to a peer that no
/// longer has anyone listening — and any rpc-reflector subscriptions
/// the previous JS session registered against `MapeoManager` stay
/// attached to the long-lived handler.
///
/// Subscribing here gives us an iOS-side reload signal independent of
/// `OnDestroy`. Each living module instance disconnects its own IPC
/// when the notification fires, so the backend observes EOF on every
/// stale connection at the moment reload begins, regardless of whether
/// or when `OnDestroy` eventually runs.
///
/// Notification choice:
/// - `RCTBridgeWillReloadNotification` is posted by RCTBridge in
///   classic-architecture iOS apps when a reload is initiated.
/// - `RCTJavaScriptWillStartLoadingNotification` is posted earlier in
///   the reload sequence on both architectures and is the most
///   reliable signal under bridgeless / new architecture, where
///   bridge-specific notifications are not always emitted.
///
/// Both are observed; whichever lands first triggers the close. The
/// callback is idempotent on `NodeJSIPC` so a double-fire is harmless.
///
/// The notification names are intentionally hard-coded as strings
/// rather than imported from React-Core so this file builds in the
/// macOS-only `ComapeoCore` Swift Package target (used by the
/// `ios/Tests/` suite). React isn't a dependency of that target.
final class JSReloadObserver {

    /// Notification names that React Native posts on JS context
    /// teardown. Tests can override this to inject a synthetic name
    /// when they don't want to drive a real RN notification.
    static let defaultNotificationNames: [Notification.Name] = [
        Notification.Name("RCTBridgeWillReloadNotification"),
        Notification.Name("RCTJavaScriptWillStartLoadingNotification"),
    ]

    private let center: NotificationCenter
    private var observers: [NSObjectProtocol] = []

    init(
        notificationNames: [Notification.Name] = JSReloadObserver.defaultNotificationNames,
        center: NotificationCenter = .default,
        onReload: @escaping () -> Void
    ) {
        self.center = center
        // Run the callback synchronously on the posting thread (queue: nil)
        // so the IPC disconnect completes before RCT continues with
        // bridge teardown — same ordering guarantee Android's OnDestroy
        // gives us, only achieved here via the notification rather than
        // a lifecycle hook.
        self.observers = notificationNames.map { name in
            center.addObserver(forName: name, object: nil, queue: nil) { _ in
                onReload()
            }
        }
    }

    deinit {
        for observer in observers {
            center.removeObserver(observer)
        }
    }
}
