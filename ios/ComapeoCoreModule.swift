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
            // OnDestroy fires reliably on iOS JS reload as of
            // expo-modules-core's PR #33760 (merged Dec 2024, shipped in
            // SDK 53+). Previously, a strong-reference cycle through
            // `MainValueConverter` kept `AppContext` alive across
            // reloads — and as long as `AppContext` stayed alive, its
            // `ModuleHolder`s stayed alive, their deinits never ran,
            // and the `.moduleDestroy` event that triggers OnDestroy
            // was never posted. PR #33760 changed
            // `MainValueConverter.appContext` to a weak reference,
            // which removes the cycle so `AppContext` can be released
            // on reload. Verified against the installed
            // `expo-modules-core@55.0.23`:
            //   ios/Core/MainValueConverter.swift:7
            //     `private(set) weak var appContext: AppContext?`
            //   ios/Core/ModuleHolder.swift:140
            //     `deinit { post(event: .moduleDestroy) }`
            // On reload: AppContext deinits → its module registry
            // releases each ModuleHolder → each ModuleHolder's deinit
            // fires `.moduleDestroy` → this block runs.
            //
            // `disconnect()` is already synchronous on iOS
            // (`shutdown(2)` → join receive loop → `close(2)`), so the
            // backend observes EOF before the OnDestroy block returns
            // and the rpc-reflector subscription cleanup runs against
            // the prior session's connection.
            //
            // If a future SDK upgrade or a third-party module
            // reintroduces a strong reference that pins `AppContext`,
            // the fallback is to subscribe to
            // `RCTBridgeWillReloadNotification` /
            // `RCTJavaScriptWillStartLoadingNotification` in OnCreate
            // and call `disconnect()` from the notification handler.
            // We don't pre-emptively wire that here — only one
            // teardown path makes the lifecycle easier to reason about.
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
    }
}
