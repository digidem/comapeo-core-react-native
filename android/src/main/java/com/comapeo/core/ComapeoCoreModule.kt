package com.comapeo.core

import android.Manifest
import com.comapeo.core.media.MediaContentProvider
import com.comapeo.core.media.MediaHttpClient
import expo.modules.interfaces.permissions.Permissions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.IOException

private typealias JsState = NodeJSService.State

class ComapeoCoreModule : Module() {
    private lateinit var ipc: NodeJSIPC
    /**
     * Read-only observer of `control.sock`. The FGS owns the writeable side
     * (init / shutdown frames); we only consume `started`/`ready`/`stopping`/`error`
     * broadcasts to derive the JS-visible lifecycle state.
     */
    private lateinit var controlIpc: NodeJSIPC

    /**
     * Serialises `jsState` + `lastError` updates: control-IPC `onMessage` and
     * `onConnectionStateChange` callbacks run on independent coroutines and can
     * fire concurrently. `sendEvent` is invoked outside the lock so a re-entrant
     * observer can't deadlock.
     */
    private val stateLock = Any()
    private var jsState: JsState = JsState.STOPPED

    /** Cleared on any non-ERROR transition so a fresh cycle can't surface stale details. */
    private var lastError: Map<String, String>? = null

    private fun setState(next: JsState, errorPayload: Map<String, String>? = null) {
        val eventToEmit: Map<String, Any>? = synchronized(stateLock) {
            when {
                jsState == next && next == JsState.ERROR && errorPayload != null -> {
                    // Refresh details on a repeat ERROR so a second error frame is visible to JS.
                    lastError = errorPayload
                    buildEventPayload(next, errorPayload)
                }
                jsState == next -> null
                else -> {
                    jsState = next
                    lastError = errorPayload
                    buildEventPayload(next, errorPayload)
                }
            }
        }
        eventToEmit?.let { sendEvent("stateChange", it) }
    }

    private fun buildEventPayload(
        state: JsState,
        errorPayload: Map<String, String>?,
    ): Map<String, Any> = buildMap {
        put("state", state.name)
        errorPayload?.let { putAll(it) }
    }

    /**
     * Mirrors the DOM `MessagePort.messageerror` channel: a frame the receiver can't
     * process (non-JSON, missing/unknown `type`) is reported separately so one bad
     * frame doesn't tear the lifecycle into ERROR.
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

            // The control socket replays `started`/`ready` to late-connecting clients,
            // so a fresh module instance always converges on the right state even if
            // it joined after the FGS finished bootstrapping.
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
                        // Sentry frames belong to the FGS-side sentry-android SDK.
                        // Capturing here would double-send.
                        is ControlFrame.SentryEvent -> {}
                        is ControlFrame.SentryEnvelope -> {}
                        is ControlFrame.Malformed -> emitMessageError(frame.detail)
                    }
                },
                onConnectionStateChange = { connState ->
                    when (connState) {
                        is NodeJSIPC.State.Connecting -> setState(JsState.STARTING)
                        is NodeJSIPC.State.Disconnecting -> setState(JsState.STOPPING)
                        is NodeJSIPC.State.Disconnected -> {
                            // A socket close from STARTING/STARTED without a preceding
                            // `stopping` frame means the backend exited unexpectedly
                            // (crash / OOM / abort). FGS-known errors arrive as real
                            // error frames via `error-native` re-broadcast and hit the
                            // ControlFrame.Error branch above before we reach this.
                            when (synchronized(stateLock) { jsState }) {
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
                        // .Connected: just "we have a socket"; wait for `started`/`ready`.
                        else -> {}
                    }
                },
            )
        }

        OnDestroy {
            // OnCreate/OnDestroy bind to the Expo AppContext (JS-runtime
            // lifetime), so they fire on every JS reload while this process
            // stays alive. Close synchronously: the backend must see EOF on the
            // old socket before the next OnCreate connects, otherwise the FD
            // lingers and rpc-reflector listeners leak onto MapeoManager.
            ipc.close()
            controlIpc.close()
        }

        OnActivityEntersForeground {
            // NodeJSIPC.connect() is idempotent; calling on every foreground transition
            // recovers from a transient FGS respawn without tracking IPC state here.
            ipc.connect()
            controlIpc.connect()
        }

        Name("ComapeoCore")

        Events("message", "messageerror", "stateChange")

        Function("postMessage") { message: String ->
            ipc.sendMessage(message)
        }

        Function("getState") {
            synchronized(stateLock) { jsState.name }
        }

        Function("getLastError") {
            synchronized(stateLock) { lastError }
        }

        // `sentryConfig` — baked-in by app.plugin.js at prebuild; spread into
        // `Sentry.init(...)` by the JS `/sentry` sub-export. Empty map when the
        // plugin isn't registered so spreading is always safe. `userId` is
        // derived with the same launch snapshot the FGS uses, so both
        // processes report the same Sentry user.id.
        Constant("sentryConfig") {
            appContext.reactContext?.let { ctx ->
                val prefs = ComapeoPrefs.open(ctx)
                SentryConfig.loadFromManifest(ctx)?.toSentryInitMap(
                    DeviceTags.compute(ctx),
                    prefs.deriveSentryUserId(prefs.readApplicationUsageData()),
                )
            } ?: emptyMap<String, Any>()
        }

        // The permanent root user ID (lazily generated on first read). Local
        // debugging aid only — Sentry sees derived hashes, never this value.
        // The host app may show it in a debug/about screen so a user can share
        // it and support can recompute their historical monthly user.ids.
        Function("getSentryRootUserId") {
            val ctx = appContext.reactContext
                ?: throw IllegalStateException(
                    "getSentryRootUserId called before native context attached",
                )
            ComapeoPrefs.open(ctx).readRootUserId()
        }

        // `sentryPreferencesAtLaunch` — the snapshot in effect this session; toggle
        // changes take effect on next launch. Returns baked-in defaults pre-attach so
        // JS can spread unconditionally. For the current saved value use
        // `getCurrentSentryPreferences`.
        Constant("sentryPreferencesAtLaunch") {
            val ctx = appContext.reactContext
            if (ctx == null) {
                mapOf(
                    "diagnosticsEnabled" to ComapeoPrefs.DEFAULT_DIAGNOSTICS_ENABLED,
                    "applicationUsageData" to ComapeoPrefs.DEFAULT_APPLICATION_USAGE_DATA,
                    "debug" to ComapeoPrefs.DEFAULT_DEBUG,
                )
            } else {
                val prefs = ComapeoPrefs.open(ctx)
                mapOf(
                    "diagnosticsEnabled" to prefs.readDiagnosticsEnabled(),
                    "applicationUsageData" to prefs.readApplicationUsageData(),
                    "debug" to prefs.readDebugEnabled(),
                )
            }
        }

        // Live read of the current persisted values — reflects a `setX` made this
        // session and survives a JS reload (unlike the `sentryPreferencesAtLaunch`
        // Constant), so a settings screen can read the user's choice without keeping
        // its own copy. Raw `debug` (no 72h auto-off side effect — that's applied by
        // readDebugEnabled at launch).
        Function("getCurrentSentryPreferences") {
            val ctx = appContext.reactContext
            if (ctx == null) {
                mapOf(
                    "diagnosticsEnabled" to ComapeoPrefs.DEFAULT_DIAGNOSTICS_ENABLED,
                    "applicationUsageData" to ComapeoPrefs.DEFAULT_APPLICATION_USAGE_DATA,
                    "debug" to ComapeoPrefs.DEFAULT_DEBUG,
                )
            } else {
                val prefs = ComapeoPrefs.open(ctx)
                mapOf(
                    "diagnosticsEnabled" to prefs.readDiagnosticsEnabled(),
                    "applicationUsageData" to prefs.readApplicationUsageData(),
                    "debug" to prefs.readDebugStored(),
                )
            }
        }

        // Restart-to-activate: writes to disk; on `false`, wipes the sentry-android
        // envelope cache so queued events never ship. The current process keeps
        // emitting in-memory until next launch.
        AsyncFunction("setDiagnosticsEnabled") { value: Boolean ->
            val ctx = appContext.reactContext
                ?: throw IllegalStateException(
                    "setDiagnosticsEnabled called before native context attached",
                )
            ComapeoPrefs.open(ctx).writeDiagnosticsEnabled(value)
            if (!value) ComapeoPrefs.wipeSentryOutbox(ctx)
        }

        AsyncFunction("setApplicationUsageData") { value: Boolean ->
            val ctx = appContext.reactContext
                ?: throw IllegalStateException(
                    "setApplicationUsageData called before native context attached",
                )
            ComapeoPrefs.open(ctx).writeApplicationUsageData(value)
            if (!value) ComapeoPrefs.wipeSentryOutbox(ctx)
        }

        AsyncFunction("setDebugEnabled") { value: Boolean ->
            val ctx = appContext.reactContext
                ?: throw IllegalStateException(
                    "setDebugEnabled called before native context attached",
                )
            ComapeoPrefs.open(ctx).writeDebugEnabled(value)
            if (!value) ComapeoPrefs.wipeSentryOutbox(ctx)
        }

        // POST_NOTIFICATIONS is the runtime gate (API 33+) for the FGS
        // notification. Below API 33 `checkSelfPermission` reports the
        // manifest-declared permission as granted, so both helpers resolve
        // `granted` without a dialog. The module only exposes these — the
        // host app decides when to call them (rationale + settings deep-link
        // UX live in the host). See docs/ForegroundService.md.
        AsyncFunction("getNotificationPermissionsAsync") { promise: Promise ->
            Permissions.getPermissionsWithPermissionsManager(
                appContext.permissions,
                promise,
                Manifest.permission.POST_NOTIFICATIONS,
            )
        }

        AsyncFunction("requestNotificationPermissionsAsync") { promise: Promise ->
            Permissions.askForPermissionsWithPermissionsManager(
                appContext.permissions,
                promise,
                Manifest.permission.POST_NOTIFICATIONS,
            )
        }

        // The authority of MediaContentProvider for the consuming app
        // (depends on its applicationId). Read once by src/mediaUrl.ts so
        // the relative blob/icon paths returned by the backend can be
        // composed into `content://<authority>/...` URIs for <Image>.
        Function("getMediaContentAuthority") {
            val ctx = appContext.reactContext
                ?: throw IllegalStateException(
                    "getMediaContentAuthority called before native context attached",
                )
            MediaContentProvider.authorityFor(ctx)
        }

        // Share-sheet URL for a blob/icon: the same streaming `content://`
        // URI the app renders with — NOT a file snapshot. Cache files were
        // observed being evicted on low-storage devices before the share
        // completed; the provider-backed URI has no bytes on disk to
        // evict, and its socket is served by the :ComapeoCore foreground
        // service, which outlives app switches. The caller's share Intent
        // must carry FLAG_GRANT_READ_URI_PERMISSION (+ setClipData) so the
        // chosen app can read it. Validates the path with a HEAD first so
        // a missing blob rejects here (like iOS) instead of failing
        // opaquely inside the receiving app — and the HEAD warms the
        // provider's metadata cache for the share sheet's immediate
        // getType/query calls.
        AsyncFunction("getShareableMediaUrl") { relativePath: String ->
            require(relativePath.startsWith("/")) {
                "Expected a relative media path beginning with '/', got: $relativePath"
            }
            val ctx = appContext.reactContext
                ?: throw IllegalStateException(
                    "getShareableMediaUrl called before native context attached",
                )
            val socketFile = File(ctx.filesDir, ComapeoCoreService.MEDIA_SOCKET_FILENAME)
            MediaHttpClient.head(socketFile, relativePath).use { response ->
                if (response.status !in 200..299) {
                    throw IOException("HTTP ${response.status} for $relativePath")
                }
                MediaContentProvider.cacheContentType(
                    relativePath,
                    response.headers["content-type"],
                )
            }
            "content://${MediaContentProvider.authorityFor(ctx)}$relativePath"
        }
    }
}
