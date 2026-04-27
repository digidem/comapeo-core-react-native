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

        Events("message", "stateChange")

        OnCreate {
            let socketPath = ComapeoCoreModule.resolveSocketPath()
            self.ipc = NodeJSIPC(socketPath: socketPath) { [weak self] message in
                self?.sendEvent("message", ["data": message])
            }

            // Observe service state changes. Static accessor — see
            // resolveSocketPath above for why we avoid `.shared` here.
            AppLifecycleDelegate.nodeService.onStateChange = { [weak self] state in
                self?.sendEvent("stateChange", ["state": state.rawValue])
            }
        }

        OnDestroy {
            self.ipc?.disconnect()
            self.ipc = nil
        }

        OnAppEntersForeground {
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
    }
}
