import ExpoModulesCore

public class ComapeoCoreModule: Module {
    private var ipc: NodeJSIPC?

    // MARK: - Testable seams
    //
    // These helpers exist so tests can verify two invariants:
    //   1. The module's IPC client path must equal the path NodeJSService binds to.
    //   2. getState() must return the same source as the stateChange event (service state).

    static func resolveSocketPath() -> String {
        // Use the static accessor on AppLifecycleDelegate (NOT `.shared`) —
        // OnCreate runs on the React Native JS thread, and lazy-initialising
        // `.shared` from off-main-thread traps under Expo 55's @MainActor
        // BaseExpoAppDelegateSubscriber.init().
        return AppLifecycleDelegate.nodeService.comapeoSocketPath
    }

    static func stateString(for service: NodeJSService, ipc: NodeJSIPC?) -> String {
        // The service owns the authoritative lifecycle state; the IPC socket's
        // connection state is a downstream concern and may transiently diverge
        // (see bug: late socket file creation, mid-session reconnects, etc.).
        return service.state.rawValue
    }

    public func definition() -> ModuleDefinition {
        Name("ComapeoCore")

        Events("message", "messageerror", "stateChange")

        OnCreate {
            let socketPath = ComapeoCoreModule.resolveSocketPath()
            self.ipc = NodeJSIPC(socketPath: socketPath) { [weak self] message in
                self?.sendEvent("message", ["data": message])
            }

            // Observe service state changes. `onStateChange` is a single-slot
            // callback — assigning here replaces any previous observer. In normal
            // app operation only one ComapeoCoreModule instance is alive at a time,
            // so the last-writer-wins semantics are fine. If Expo ever creates two
            // simultaneous module instances (e.g. during a hot-reload handoff), only
            // the new instance will receive stateChange events until the old one is
            // destroyed.
            AppLifecycleDelegate.nodeService.onStateChange = { [weak self] state in
                var payload: [String: Any] = ["state": state.rawValue]
                // Attach the captured error detail when the new state is .error
                // so JS sees a single event with both the state and the cause,
                // rather than having to follow up with getLastError().
                if state == .error,
                   let info = AppLifecycleDelegate.nodeService.getLastError() {
                    payload["errorPhase"] = info.phase
                    payload["errorMessage"] = info.message
                }
                self?.sendEvent("stateChange", payload)
            }

            // Forward control-frame parse failures to JS as a
            // `messageerror` event (mirrors DOM MessagePort). Decoupled
            // from `onStateChange` so a single garbled frame doesn't
            // affect the lifecycle state.
            AppLifecycleDelegate.nodeService.onMessageError = { [weak self] detail in
                self?.sendEvent("messageerror", ["data": detail])
            }
        }

        OnDestroy {
            self.ipc?.disconnect()
            self.ipc = nil
        }

        OnAppEntersForeground {
            // `connect()` on NodeJSIPC is idempotent: it early-returns
            // when the IPC is already .connected/.connecting/.disconnecting
            // and resets a prior .error state so a fresh connect attempt
            // can succeed. Calling it on every foreground is the cheap
            // way to recover from a transient connection failure (e.g.
            // an iOS suspension that closed the underlying fd) without
            // tracking IPC state at this layer.
            self.ipc?.connect()
        }

        Function("postMessage") { (message: String) in
            self.ipc?.sendMessage(message)
        }

        Function("getState") { () -> String in
            // Static accessor — Function callbacks may run off-main-thread
            // and `.shared`'s lazy init is @MainActor under Expo 55.
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

        // Sentry options that map cleanly to `Sentry.init({...})`,
        // baked in by `app.plugin.js` at prebuild. The JS sub-export
        // re-exports this as `sentryConfig`; consumers spread it
        // alongside their own options so RN-side and Node-side
        // events share `release`, `environment`, etc.
        //
        // Empty map when the plugin isn't registered (or DSN absent)
        // so spreading is always safe on the JS side.
        Constant("sentryConfig") { () -> [String: Any] in
            SentryConfig.loadFromMainBundle()?.toSentryInitMap() ?? [:]
        }

        // User's persisted sentry preferences, read at module
        // construction. Snapshot-at-launch: changes don't take effect
        // until next launch (see `setDiagnosticsEnabled` /
        // `setCaptureApplicationData`). The JS `/sentry` sub-export
        // reads this during `initSentry()` to decide whether to call
        // `Sentry.init` and at what tier.
        Constant("sentryPreferences") { () -> [String: Any] in
            let prefs = ComapeoPrefs.open()
            return [
                "diagnosticsEnabled": prefs.readDiagnosticsEnabled(),
                "captureApplicationData": prefs.readCaptureApplicationData(),
            ]
        }

        // Restart-to-activate: writes the new value to UserDefaults
        // and, on a transition to `false`, wipes the sentry-cocoa
        // envelope cache so events queued in the current session
        // never ship. The current process keeps emitting in-memory
        // until the next launch; that's the documented trade-off.
        AsyncFunction("setDiagnosticsEnabled") { (value: Bool) in
            ComapeoPrefs.open().writeDiagnosticsEnabled(value)
            if !value { ComapeoPrefs.wipeSentryOutbox() }
        }

        // Same shape as setDiagnosticsEnabled. The outbox wipe on
        // `false` is full (not just trace envelopes) — selective
        // wipe would be a lot of code for the same effect when an
        // outbox is mixed.
        AsyncFunction("setCaptureApplicationData") { (value: Bool) in
            ComapeoPrefs.open().writeCaptureApplicationData(value)
            if !value { ComapeoPrefs.wipeSentryOutbox() }
        }
    }
}
