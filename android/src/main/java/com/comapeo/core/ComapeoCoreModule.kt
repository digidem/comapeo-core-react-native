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
     * process). The IPC's connect loop retries until the FGS / Node binds.
     */
    private lateinit var controlIpc: NodeJSIPC

    /**
     * Single mutex protecting `jsState` and `lastError`. `setState` is
     * called from two independent control-IPC callbacks (`onMessage`
     * and `onConnectionStateChange`) which run on separate IPC
     * coroutines and can fire concurrently — e.g. an ERROR frame
     * arriving on the receive loop while the connection-state stream
     * is firing Disconnected. Without serialisation the two updates
     * would interleave and produce a dropped-or-overwritten state plus
     * an event payload that disagrees with what `getState()` returns
     * when JS reads it from the listener.
     *
     * The lock is held for the read-modify-write only; `sendEvent` is
     * invoked outside it so an observer that synchronously calls back
     * into the module can't deadlock.
     */
    private val stateLock = Any()
    private var jsState: JsState = JsState.STOPPED

    /**
     * Last error captured from the backend's `{type:"error",…}` frame or
     * derived from a connection-level `NodeJSIPC.State.Error`. Cleared on
     * any non-ERROR transition so a fresh start cycle doesn't surface
     * stale details. Exposed to JS via `getLastError()`.
     */
    private var lastError: Map<String, String>? = null

    private fun setState(next: JsState, errorPayload: Map<String, String>? = null) {
        var eventToEmit: Map<String, Any>? = null
        synchronized(stateLock) {
            if (jsState == next) {
                // Even if state is unchanged, refresh error details when
                // the caller has new ones — a second error frame in the
                // same ERROR state should still be visible to JS.
                if (next == JsState.ERROR && errorPayload != null) {
                    lastError = errorPayload
                    eventToEmit = buildEventPayload(next, errorPayload)
                }
                return@synchronized
            }
            jsState = next
            lastError = errorPayload
            eventToEmit = buildEventPayload(next, errorPayload)
        }
        eventToEmit?.let { sendEvent("stateChange", it) }
    }

    private fun buildEventPayload(
        state: JsState,
        errorPayload: Map<String, String>?,
    ): Map<String, Any> {
        val payload = mutableMapOf<String, Any>("state" to state.raw)
        errorPayload?.let { payload.putAll(it) }
        return payload
    }

    /**
     * Emits a `messageerror` event mirroring the DOM `MessagePort`
     * counterpart: a frame the receiver can't process (non-JSON, missing
     * `type`, or unknown `type`) is reported on a separate channel
     * rather than tearing the lifecycle into ERROR. The malformed frame
     * is a real bug — backend ships with native — but a single bad
     * frame shouldn't take down a working session; subsequent valid
     * frames continue to drive normal state.
     */
    private fun emitMessageError(detail: String) {
        sendEvent("messageerror", mapOf("data" to detail))
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
                    when (val frame = ControlFrame.parse(message)) {
                        ControlFrame.Started -> setState(JsState.STARTING)
                        ControlFrame.Ready -> setState(JsState.STARTED)
                        ControlFrame.Stopping -> setState(JsState.STOPPING)
                        is ControlFrame.Error -> setState(
                            JsState.ERROR,
                            mapOf(
                                "errorPhase" to frame.phase,
                                "errorMessage" to frame.message,
                            ),
                        )
                        // The FGS process owns the Sentry-Android SDK
                        // initialised with the Node DSN — Sentry frames
                        // are handled there, in
                        // `NodeJSService.handleControlMessage`. The
                        // main-app process receives the same broadcasts
                        // and ignores them; capturing here would
                        // double-send to Sentry.
                        is ControlFrame.SentryEvent -> {}
                        is ControlFrame.SentryEnvelope -> {}
                        is ControlFrame.Malformed -> emitMessageError(frame.detail)
                    }
                },
                onConnectionStateChange = { connState ->
                    when (connState) {
                        is NodeJSIPC.State.Connecting -> setState(JsState.STARTING)
                        // .Connected by itself is just "we have a socket";
                        // we wait for `started`/`ready` to advance state.
                        is NodeJSIPC.State.Disconnecting -> setState(JsState.STOPPING)
                        is NodeJSIPC.State.Disconnected -> {
                            // Distinguish graceful from unexpected disconnect
                            // by what state we were in when the socket
                            // closed:
                            //
                            //   ERROR    — already terminal, don't downgrade.
                            //   STOPPING — graceful exit (we either saw
                            //              `stopping` from the backend, or
                            //              the FGS-side asked us to stop and
                            //              we propagated). Land in STOPPED.
                            //   STOPPED  — already there, idempotent.
                            //   STARTING/STARTED — the socket closed without
                            //              a preceding `stopping` frame, so
                            //              the backend exited unexpectedly
                            //              (crash, OOM kill, abort()). Surface
                            //              as ERROR with a synthetic phase so
                            //              the application can react. Errors
                            //              the FGS knows about (rootkey,
                            //              watchdog) come through `error-native`
                            //              → backend re-broadcast → real error
                            //              frame, so they hit the
                            //              `ControlFrame.Error` branch above
                            //              with their actual phase before we
                            //              get here.
                            val current = synchronized(stateLock) { jsState }
                            when (current) {
                                JsState.ERROR -> {}
                                JsState.STOPPING, JsState.STOPPED -> setState(JsState.STOPPED)
                                JsState.STARTING, JsState.STARTED -> setState(
                                    JsState.ERROR,
                                    mapOf(
                                        "errorPhase" to "node-runtime-unexpected",
                                        "errorMessage" to "Backend disconnected unexpectedly",
                                    ),
                                )
                            }
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
        Events("message", "messageerror", "stateChange")

        // Defines a JavaScript synchronous function that runs the native code on the JavaScript thread.
        Function("postMessage") { message: String ->
            ipc.sendMessage(message)
        }

        Function("getState") {
            synchronized(stateLock) { jsState.raw }
        }

        Function("getLastError") {
            // Return null when there's no captured error so JS sees a
            // clean `null`, not an empty object that callers have to
            // sentinel-check.
            synchronized(stateLock) { lastError }
        }

        // Sentry options that map cleanly to `Sentry.init({...})`,
        // baked in by `app.plugin.js` at prebuild. The JS sub-export
        // re-exports this as `sentryConfig`; consumers spread it
        // alongside their own options so RN-side and Node-side
        // events share `release`, `environment`, etc.
        //
        // Empty map when the plugin isn't registered (or DSN absent)
        // so spreading is always safe on the JS side.
        Constant("sentryConfig") {
            appContext.reactContext?.let {
                SentryConfig.loadFromManifest(it)?.toSentryInitMap()
            } ?: emptyMap<String, Any>()
        }

        // User's persisted sentry preferences, read at module
        // construction. Snapshot-at-boot: changes don't take effect
        // until next launch (see `setDiagnosticsEnabled` /
        // `setCaptureApplicationData`). The JS `/sentry` sub-export
        // reads this during `initSentry()` to decide whether to call
        // `Sentry.init` and at what tier.
        //
        // Returns the baked-in defaults when no react context is
        // available (test / pre-attach) so the JS side never gets
        // null and can spread the map unconditionally.
        Constant("sentryPreferences") {
            val ctx = appContext.reactContext
            if (ctx == null) {
                mapOf(
                    "diagnosticsEnabled" to ComapeoPrefs.DEFAULT_DIAGNOSTICS_ENABLED,
                    "captureApplicationData" to ComapeoPrefs.DEFAULT_CAPTURE_APPLICATION_DATA,
                )
            } else {
                val prefs = ComapeoPrefs.open(ctx)
                mapOf(
                    "diagnosticsEnabled" to prefs.readDiagnosticsEnabled(),
                    "captureApplicationData" to prefs.readCaptureApplicationData(),
                )
            }
        }

        // Restart-to-activate: writes the new value to disk and, on
        // a transition to `false`, wipes the sentry-android envelope
        // cache so events queued in the current session never ship.
        // The current process keeps emitting in-memory until the
        // next launch; that's the documented trade-off.
        AsyncFunction("setDiagnosticsEnabled") { value: Boolean ->
            val ctx = appContext.reactContext
                ?: throw IllegalStateException(
                    "setDiagnosticsEnabled called before native context attached",
                )
            ComapeoPrefs.open(ctx).writeDiagnosticsEnabled(value)
            if (!value) ComapeoPrefs.wipeSentryOutbox(ctx)
        }

        // Same shape as setDiagnosticsEnabled. The outbox wipe on
        // `false` is full (not just trace envelopes) — selective
        // wipe would be a lot of code for the same effect when an
        // outbox is mixed.
        AsyncFunction("setCaptureApplicationData") { value: Boolean ->
            val ctx = appContext.reactContext
                ?: throw IllegalStateException(
                    "setCaptureApplicationData called before native context attached",
                )
            ComapeoPrefs.open(ctx).writeCaptureApplicationData(value)
            if (!value) ComapeoPrefs.wipeSentryOutbox(ctx)
        }
    }
}
