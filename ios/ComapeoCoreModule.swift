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
            // Fires on every JS reload as of expo-modules-core SDK 53+ (weak
            // MainValueConverter.appContext lets AppContext deinit; verified on
            // 56). No iOS equivalent of the Android close() is needed: iOS
            // disconnect() shutdown(2)s before joining the receive loop, so the
            // backend sees EOF synchronously without the cancelAndJoin deadlock.
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
            SentryConfig.loadFromMainBundle()?
                .toSentryInitMap(deviceTags: DeviceTags.compute()) ?? [:]
        }

        // The snapshot in effect this session. Toggle changes take effect on
        // next launch (see `setDiagnosticsEnabled` / `setApplicationUsageData`
        // / `setDebugEnabled`). For the current saved value use
        // `getCurrentSentryPreferences`.
        Constant("sentryPreferencesAtLaunch") { () -> [String: Any] in
            let prefs = ComapeoPrefs.open()
            return [
                "diagnosticsEnabled": prefs.readDiagnosticsEnabled(),
                "applicationUsageData": prefs.readApplicationUsageData(),
                "debug": prefs.readDebugEnabled(),
            ]
        }

        // Live read of the current persisted values — reflects a `setX` made
        // this session and survives a JS reload (unlike the
        // `sentryPreferencesAtLaunch` Constant), so a settings screen can read
        // the user's choice without keeping its own copy. Raw `debug` (no 72h
        // auto-off side effect — that's applied by readDebugEnabled at launch).
        Function("getCurrentSentryPreferences") { () -> [String: Any] in
            let prefs = ComapeoPrefs.open()
            return [
                "diagnosticsEnabled": prefs.readDiagnosticsEnabled(),
                "applicationUsageData": prefs.readApplicationUsageData(),
                "debug": prefs.readDebugStored(),
            ]
        }

        // Restart-to-activate. On `false`, wipe the sentry-cocoa outbox
        // so events queued this session never ship; the current process
        // keeps emitting in-memory until next launch.
        AsyncFunction("setDiagnosticsEnabled") { (value: Bool) in
            ComapeoPrefs.open().writeDiagnosticsEnabled(value)
            if !value { ComapeoPrefs.wipeSentryOutbox() }
        }

        AsyncFunction("setApplicationUsageData") { (value: Bool) in
            ComapeoPrefs.open().writeApplicationUsageData(value)
            if !value { ComapeoPrefs.wipeSentryOutbox() }
        }

        AsyncFunction("setDebugEnabled") { (value: Bool) in
            ComapeoPrefs.open().writeDebugEnabled(value)
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

    // Testable seam: the constant value both notification AsyncFunctions
    // resolve. iOS has no FGS runtime gate, so it's always `granted`.
    static let grantedPermissionResponse: [String: Any] = [
        "status": "granted",
        "granted": true,
        "canAskAgain": true,
        "expires": "never",
    ]
}
