import ExpoModulesCore

public class ComapeoCoreModule: Module {
    private var ipc: NodeJSIPC?

    // Testable seams. Tests verify two invariants:
    //   1. The IPC client path equals the path NodeJSService binds to.
    //   2. getState() returns the same source as the stateChange event.

    /// Static accessor (NOT `.shared`) — `OnCreate` runs on the RN JS
    /// thread, and `.shared`'s lazy init is `@MainActor` under Expo 55.
    static func resolveSocketPath() -> String {
        AppLifecycleDelegate.nodeService.comapeoSocketPath
    }

    static func stateString(for service: NodeJSService, ipc: NodeJSIPC?) -> String {
        // Service owns the authoritative lifecycle state; IPC connection
        // state may transiently diverge.
        service.state.rawValue
    }

    public func definition() -> ModuleDefinition {
        Name("ComapeoCore")

        Events("message", "messageerror", "stateChange")

        OnCreate {
            let socketPath = ComapeoCoreModule.resolveSocketPath()
            self.ipc = NodeJSIPC(socketPath: socketPath) { [weak self] message in
                self?.sendEvent("message", ["data": message])
            }

            // `onStateChange` is single-slot — last-writer-wins. Fine in
            // practice; only one module instance is alive at a time.
            AppLifecycleDelegate.nodeService.onStateChange = { [weak self] state in
                var payload: [String: Any] = ["state": state.rawValue]
                if state == .error,
                   let info = AppLifecycleDelegate.nodeService.getLastError() {
                    payload["errorPhase"] = info.phase
                    payload["errorMessage"] = info.message
                }
                self?.sendEvent("stateChange", payload)
            }

            // Mirrors DOM MessagePort `messageerror`: malformed frames
            // don't transition lifecycle state.
            AppLifecycleDelegate.nodeService.onMessageError = { [weak self] detail in
                self?.sendEvent("messageerror", ["data": detail])
            }
        }

        OnDestroy {
            self.ipc?.disconnect()
            self.ipc = nil
        }

        OnAppEntersForeground {
            // `connect()` is idempotent and resets `.error` — cheap
            // recovery from a suspension that closed the fd.
            self.ipc?.connect()
        }

        Function("postMessage") { (message: String) in
            self.ipc?.sendMessage(message)
        }

        Function("getState") { () -> String in
            ComapeoCoreModule.stateString(
                for: AppLifecycleDelegate.nodeService,
                ipc: self.ipc
            )
        }

        Function("getLastError") { () -> [String: String]? in
            guard let info = AppLifecycleDelegate.nodeService.getLastError() else {
                return nil
            }
            return ["errorPhase": info.phase, "errorMessage": info.message]
        }

        // Plist-baked Sentry options, re-exported by the JS `/sentry`
        // sub-export. Empty map when DSN absent so spreading is safe.
        Constant("sentryConfig") { () -> [String: Any] in
            SentryConfig.loadFromMainBundle()?.toSentryInitMap() ?? [:]
        }

        // Snapshot-at-launch. Toggle changes take effect on next launch
        // (see `setDiagnosticsEnabled` / `setCaptureApplicationData`).
        Constant("sentryPreferences") { () -> [String: Any] in
            let prefs = ComapeoPrefs.open()
            return [
                "diagnosticsEnabled": prefs.readDiagnosticsEnabled(),
                "captureApplicationData": prefs.readCaptureApplicationData(),
            ]
        }

        // Restart-to-activate. On `false`, wipe the sentry-cocoa outbox
        // so events queued this session never ship; the current process
        // keeps emitting in-memory until next launch.
        AsyncFunction("setDiagnosticsEnabled") { (value: Bool) in
            ComapeoPrefs.open().writeDiagnosticsEnabled(value)
            if !value { ComapeoPrefs.wipeSentryOutbox() }
        }

        AsyncFunction("setCaptureApplicationData") { (value: Bool) in
            ComapeoPrefs.open().writeCaptureApplicationData(value)
            if !value { ComapeoPrefs.wipeSentryOutbox() }
        }

        // POST_NOTIFICATIONS gates the Android FGS notification only; iOS has
        // no foreground service and no matching runtime gate, so both methods
        // resolve `granted` to keep host code cross-platform. (User-facing
        // notification permission on iOS is a separate concern handled via
        // expo-notifications, not the FGS.)
        AsyncFunction("getNotificationPermissionsAsync") { () -> [String: Any] in
            ComapeoCoreModule.grantedPermissionResponse
        }

        AsyncFunction("requestNotificationPermissionsAsync") { () -> [String: Any] in
            ComapeoCoreModule.grantedPermissionResponse
        }
    }

    private static let grantedPermissionResponse: [String: Any] = [
        "status": "granted",
        "granted": true,
        "canAskAgain": true,
        "expires": "never",
    ]
}
