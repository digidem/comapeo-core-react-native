package com.comapeo.core

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONException
import org.json.JSONObject
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

    /**
     * Last error captured from the backend's `{type:"error",…}` frame or
     * derived from a connection-level `NodeJSIPC.State.Error`. Cleared on
     * any non-ERROR transition so a fresh start cycle doesn't surface
     * stale details. Exposed to JS via `getLastError()`.
     */
    @Volatile
    private var lastError: Map<String, String>? = null

    private fun setState(next: JsState, errorPayload: Map<String, String>? = null) {
        if (jsState == next) {
            // Even if state is unchanged, refresh error details when the
            // caller has new ones — a second error frame in the same ERROR
            // state should still be visible to JS.
            if (next == JsState.ERROR && errorPayload != null) {
                lastError = errorPayload
                sendEvent("stateChange", buildEventPayload(next, errorPayload))
            }
            return
        }
        jsState = next
        lastError = errorPayload
        sendEvent("stateChange", buildEventPayload(next, errorPayload))
    }

    private fun buildEventPayload(
        state: JsState,
        errorPayload: Map<String, String>?,
    ): Map<String, Any> {
        val payload = mutableMapOf<String, Any>("state" to state.raw)
        errorPayload?.let { payload.putAll(it) }
        return payload
    }

    private fun parseFrame(message: String): JSONObject? = try {
        JSONObject(message)
    } catch (e: JSONException) {
        // The control socket protocol is JSON-only — non-JSON traffic
        // means either a backend bug or a corrupt frame. Log loudly so
        // it's visible in adb logcat / Sentry, but don't transition to
        // ERROR: a single garbled frame shouldn't tear down a working
        // session. The watchdog covers the case where the protocol has
        // genuinely broken (no `ready` ever arrives).
        log("ComapeoCoreModule: ignoring non-JSON control frame: ${e.message}")
        null
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
                    val parsed = parseFrame(message) ?: return@NodeJSIPC
                    val type = parsed.optString("type", "")
                    when (type) {
                        "ready" -> setState(JsState.STARTED)
                        "started" -> setState(JsState.STARTING)
                        "error" -> setState(
                            JsState.ERROR,
                            mapOf(
                                "errorPhase" to parsed.optString("phase", "unknown"),
                                "errorMessage" to parsed.optString("message", "(no message)"),
                            ),
                        )
                        else -> {
                            // Forward-compat: a newer backend may emit
                            // frame types this build doesn't recognise.
                            // Log so it's discoverable, but don't error
                            // — the watchdog covers genuine protocol
                            // breakage (no `ready` within timeout).
                            log("ComapeoCoreModule: ignoring unknown control frame type=\"$type\"")
                        }
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
                        is NodeJSIPC.State.Error -> setState(
                            JsState.ERROR,
                            mapOf(
                                "errorPhase" to "ipc",
                                "errorMessage" to (connState.exception.message
                                    ?: connState.exception.javaClass.simpleName),
                            ),
                        )
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
            // `connect()` is idempotent on `NodeJSIPC`: it early-returns
            // when the IPC is already in Connected/Connecting/Disconnecting
            // and resets a prior `Error` state so the next attempt can
            // succeed. Calling it on every foreground transition is
            // therefore the cheap way to recover from a transient
            // connection failure (e.g. the FGS was killed and respawned
            // while the app was backgrounded) without us tracking the
            // IPC state ourselves at this layer.
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

        Function("getState") {
            jsState.raw
        }

        Function("getLastError") {
            // Return null when there's no captured error so JS sees a
            // clean `null`, not an empty object that callers have to
            // sentinel-check.
            lastError
        }
    }
}
