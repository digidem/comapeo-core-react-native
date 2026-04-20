import ExpoModulesCore

public class ComapeoCoreModule: Module {
    private var ipc: NodeJSIPC?

    // MARK: - Testable seams
    //
    // These helpers exist so tests can verify two invariants:
    //   1. The module's IPC client path must equal the path NodeJSService binds to.
    //   2. getState() must return the same source as the stateChange event (service state).
    //
    // The current implementations reproduce the (buggy) production behavior so that
    // the failing tests fail for the right reason. They will be fixed in a follow-up.

    static func resolveSocketPath() -> String {
        let documentsDir = NSSearchPathForDirectoriesInDomains(.documentDirectory, .userDomainMask, true).first!
        return (documentsDir as NSString).appendingPathComponent(NodeJSService.comapeoSocketFilename)
    }

    static func stateString(for service: NodeJSService, ipc: NodeJSIPC?) -> String {
        guard let ipc = ipc else { return "STOPPED" }
        switch ipc.state {
        case .connected: return "STARTED"
        case .connecting: return "STARTING"
        case .disconnected: return "STOPPED"
        case .disconnecting: return "STOPPING"
        case .error: return "ERROR"
        }
    }

    public func definition() -> ModuleDefinition {
        Name("ComapeoCore")

        Events("message", "stateChange")

        OnCreate {
            let socketPath = ComapeoCoreModule.resolveSocketPath()
            self.ipc = NodeJSIPC(socketPath: socketPath) { [weak self] message in
                self?.sendEvent("message", ["data": message])
            }

            // Observe service state changes
            AppLifecycleDelegate.shared.nodeService.onStateChange = { [weak self] state in
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
            ComapeoCoreModule.stateString(
                for: AppLifecycleDelegate.shared.nodeService,
                ipc: self.ipc
            )
        }
    }
}
