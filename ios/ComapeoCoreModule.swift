import ExpoModulesCore

public class ComapeoCoreModule: Module {
    private var ipc: NodeJSIPC?
    /// Observes RN-posted reload notifications and disconnects the IPC
    /// when the JS context is about to be torn down. Required because
    /// Expo's `OnDestroy` does not fire on iOS reload (expo/expo#33655),
    /// so the lifecycle-only path that works on Android leaves stale
    /// sockets attached on every reload here. See `JSReloadObserver`
    /// for the full rationale and choice of notification names.
    private var reloadObserver: JSReloadObserver?

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

            // Subscribe to RN's reload notifications so the IPC closes
            // before a fresh JS context opens its own connection. This
            // is the iOS analogue of Android's `OnDestroy { close() }`
            // — necessary because Expo's `OnDestroy` does not fire on
            // iOS JS reload (expo/expo#33655). `disconnect()` is
            // already synchronous on iOS (`shutdown(2)` → join receive
            // loop → `close(2)`), so the backend observes EOF before
            // the notification handler returns.
            self.reloadObserver = JSReloadObserver { [weak self] in
                self?.ipc?.disconnect()
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
            // OnDestroy is unreliable on iOS reload (expo/expo#33655) —
            // the equivalent teardown is wired via `reloadObserver`
            // above. This block still runs on the regular paths it
            // does fire on (e.g. final module deinit during process
            // exit) and is kept idempotent so the two paths can race
            // without harm: `disconnect()` early-returns when state
            // is already `.disconnecting`/`.disconnected`.
            self.reloadObserver = nil
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
