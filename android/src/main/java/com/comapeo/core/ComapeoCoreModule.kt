package com.comapeo.core

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

/**
 * Module-side mirror of `NodeJSService.State`. Strings match the iOS
 * `NodeJSService.State` rawValue alphabet so the JS layer can use a single
 * union of state names regardless of platform.
 */
private enum class JsState(val raw: String) {
    STOPPED("STOPPED"),
    STARTING("STARTING"),
    STARTED("STARTED"),
    STOPPING("STOPPING"),
    ERROR("ERROR"),
}

class ComapeoCoreModule : Module() {
    private lateinit var ipc: NodeJSIPC
    /**
     * Read-only observer of `control.sock` running in the main app process.
     * The FGS owns the writeable side (sending the rootkey init frame, the
     * shutdown frame); we only listen for the broadcast `started`/`ready`
     * messages so we can derive the JS-visible lifecycle state.
     *
     * The control socket file lives in the app's filesDir, accessible from
     * any process that shares the same UID (i.e. the FGS and the main
     * process). The IPC's `waitForFile` polls until the FGS / Node binds.
     */
    private lateinit var controlIpc: NodeJSIPC

    @Volatile
    private var jsState: JsState = JsState.STOPPED

    private fun setState(next: JsState) {
        if (jsState == next) return
        jsState = next
        sendEvent("stateChange", mapOf("state" to next.raw))
    }

    override fun definition() = ModuleDefinition {
        OnCreate {
            val socketFile =
                File(appContext.persistentFilesDirectory, ComapeoCoreService.COMAPEO_SOCKET_FILENAME)
            val controlSocketFile =
                File(appContext.persistentFilesDirectory, ComapeoCoreService.CONTROL_SOCKET_FILENAME)

            ipc = NodeJSIPC(socketFile) { message ->
                sendEvent("message", mapOf("data" to message))
            }

            // Derive JS-visible state from control-channel messages and the
            // IPC's own connection state. The control socket replays
            // `started`/`ready` to late-connecting clients, so a fresh
            // ComapeoCoreModule instance always converges on the right state
            // even if it joined after the FGS finished bootstrapping.
            controlIpc = NodeJSIPC(
                controlSocketFile,
                onMessage = { message ->
                    when {
                        message.contains("\"ready\"") -> setState(JsState.STARTED)
                        message.contains("\"started\"") -> setState(JsState.STARTING)
                    }
                },
                onConnectionStateChange = { connState ->
                    when (connState) {
                        is NodeJSIPC.State.Connecting -> setState(JsState.STARTING)
                        // .Connected by itself is just "we have a socket";
                        // we wait for `started`/`ready` to advance state.
                        is NodeJSIPC.State.Disconnecting -> setState(JsState.STOPPING)
                        is NodeJSIPC.State.Disconnected -> {
                            // Don't downgrade ERROR (terminal until next start).
                            if (jsState != JsState.ERROR) setState(JsState.STOPPED)
                        }
                        is NodeJSIPC.State.Error -> setState(JsState.ERROR)
                        else -> {}
                    }
                },
            )
        }

        OnDestroy {
            ipc.disconnect()
            controlIpc.disconnect()
        }

        OnActivityEntersForeground {
            ipc.connect()
            controlIpc.connect()
        }


        // Sets the name of the module that JavaScript code will use to refer to the module. Takes a string as an argument.
        // Can be inferred from module's class name, but it's recommended to set it explicitly for clarity.
        // The module will be accessible from `requireNativeModule('ComapeoCore')` in JavaScript.
        Name("ComapeoCore")

        // Defines event names that the module can send to JavaScript.
        Events("message", "stateChange")

        // Defines a JavaScript synchronous function that runs the native code on the JavaScript thread.
        Function("postMessage") { message: String ->
            ipc.sendMessage(message)
        }

        Function("getState") { ->
            jsState.raw
        }
    }
}
