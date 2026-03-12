import ExpoModulesCore

public class ComapeoCoreModule: Module {
    private var ipc: NodeJSIPC?

    public func definition() -> ModuleDefinition {
        Name("ComapeoCore")

        Events("message", "stateChange")

        OnCreate {
            let documentsDir = NSSearchPathForDirectoriesInDomains(.documentDirectory, .userDomainMask, true).first!
            let socketPath = (documentsDir as NSString).appendingPathComponent(NodeJSService.comapeoSocketFilename)
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
            guard let ipc = self.ipc else { return "STOPPED" }
            switch ipc.state {
            case .connected: return "STARTED"
            case .connecting: return "STARTING"
            case .disconnected: return "STOPPED"
            case .disconnecting: return "STOPPING"
            case .error: return "ERROR"
            }
        }
    }
}
