package com.comapeo.core

import android.content.ContextWrapper
import android.util.Base64
import android.util.Log
import androidx.annotation.VisibleForTesting
import androidx.core.content.edit
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.getAndUpdate
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File
import java.util.concurrent.atomic.AtomicReference

@Serializable
data class ShutdownMessage(val type: String = "shutdown")

/**
 * Native→Node frame for cross-process attribution of FGS-side local failures
 * (rootkey, startup watchdog). The backend's `error-native` handler re-broadcasts
 * and exits, so the main-app process sees a real `error` frame with the actual
 * phase rather than a generic "unexpected disconnect".
 */
@Serializable
private data class ErrorNativeMessage(
    val type: String = "error-native",
    val phase: String,
    val message: String,
)

const val APK_LAST_UPDATE_TIME_KEY = "apk_last_update_time"
const val SHARED_PREFS_NAME_POSTFIX = "_nodejs_preferences"
const val NODEJS_PROJECT_DIRNAME = "nodejs-project"
// loader.mjs parses --sentry* argv, optionally inits @sentry/node, then imports index.mjs.
const val NODEJS_PROJECT_INDEX_FILENAME = "loader.mjs"
// Optional default project config the consuming app bundles via the Expo
// plugin (app.plugin.js) into `assets/nodejs-project/`; extracted into
// nodeProjectDir alongside the backend. Absent → no default config.
const val DEFAULT_CONFIG_FILENAME = "comapeo-default-config.comapeocat"
// Manifest meta-data written by app.plugin.js when the consumer sets
// `defaultOnlineStyleUrl`. Forwarded to the backend as the 5th argv
// positional; absent → backend uses its built-in default.
const val META_DEFAULT_ONLINE_STYLE_URL = "com.comapeo.core.map.defaultOnlineStyleUrl"

/** Bound on `ipcDeferred.await()` in [sendErrorNativeFrame] so a never-completing
 *  deferred (FGS failed before NodeJSIPC was constructed) doesn't pin a coroutine. */
private const val SEND_ERROR_NATIVE_TIMEOUT_MS = 2_000L

@Suppress("KotlinJniMissingFunction")
class NodeJSService(
    context: android.content.Context,
    /** Forwarded as `--sentry*` argv to backend/loader.mjs. `null` → loader skips Sentry. */
    private val sentryConfig: SentryConfig? = null,
    /** Gates the usage-tier metric dimensions (RPC `method`, sync volume buckets) on the backend. Ignored when [sentryConfig] is null. */
    private val applicationUsageData: Boolean = false,
    /** Per-RPC tracing + consoleIntegration when `true`. Ignored when [sentryConfig] is null. */
    private val debug: Boolean = false,
    /** Device classification tags forwarded to Node for the `.by_device` metrics. */
    private val deviceTags: DeviceTags? = null,
    /** Derived Sentry user.id (monthly/permanent hash) forwarded as `--sentryUserId`. */
    private val sentryUserId: String? = null,
    /** Max ms in STARTING before the watchdog forces ERROR. 30 s covers cold boot + native addon dlopens. */
    private val startupTimeoutMs: Long = 30_000,
) : ContextWrapper(context) {
    /**
     * Public lifecycle state mirroring iOS's `NodeJSService.State`. *Derived* —
     * see [deriveState] for inputs. ComapeoCoreService forwards transitions to
     * the JS layer via the Expo module.
     *
     * - STOPPED  — initial.
     * - STARTING — Node spawned (or about to be); awaiting `ready` on the control
     *              socket. Rootkey handshake happens in this window.
     * - STARTED  — RPC safe; comapeo socket bound.
     * - STOPPING — graceful shutdown initiated.
     * - ERROR    — observable failure. `getLastError()` carries the detail.
     *
     * **ERROR is per-instance terminal.** `start()` and `stop()` refuse it;
     * recovery is `destroy()` + create a fresh instance. The FGS does this
     * naturally by creating a new NodeJSService in `onCreate` for each start.
     * The node thread may still be alive on ERROR — `destroy()` releases it.
     */
    enum class State {
        STOPPED, STARTING, STARTED, STOPPING, ERROR
    }

    /**
     * Structured detail attached to ERROR. Sourced from the backend's
     * `{type:"error",phase,message,…}` frame or synthesized on unexpected exit.
     * `phase` is one of the backend's boot-phase strings (`listen-control`, `init`,
     * `construct`, `runtime`) or a local phase (`extract-assets`, `rootkey`,
     * `starting-timeout`, `node-runtime`, `node-runtime-unexpected`).
     */
    data class ErrorInfo(val phase: String, val message: String)

    /**
     * Node runtime-thread lifecycle. `Exited` carries an [ExitReason] so an
     * unexpected exit (native-addon crash, `process.abort()`) derives to ERROR
     * rather than STOPPED.
     */
    sealed class NodeRuntimeState {
        object NotRunning : NodeRuntimeState()
        object Running : NodeRuntimeState()
        data class Exited(val code: Int, val reason: ExitReason) : NodeRuntimeState()
    }

    enum class ExitReason {
        /** stop() was called or a `stopping` frame arrived before exit. */
        REQUESTED,
        /** Thread returned without a stop signal. Derives to ERROR. */
        UNEXPECTED,
    }

    /**
     * Backend status reported via control-socket frames (plus local failures sharing
     * the same slot). `Unknown` = no frames yet; `ControlBound` = saw `started`,
     * awaiting init→ready.
     */
    sealed class BackendState {
        object Unknown : BackendState()
        object ControlBound : BackendState()
        object Ready : BackendState()
        object Stopping : BackendState()
        data class Error(val phase: String, val message: String) : BackendState()
    }

    /**
     * Atomic snapshot of the three component states + derived `state` + most-recent
     * error. One `MutableStateFlow` so CAS updates the tuple as a unit and observers
     * always see a matching `(state, lastError)` view.
     */
    private data class ComponentSnapshot(
        val nodeRuntime: NodeRuntimeState = NodeRuntimeState.NotRunning,
        val backendState: BackendState = BackendState.Unknown,
        val stopRequested: Boolean = false,
        val state: State = State.STOPPED,
        val lastError: ErrorInfo? = null,
    )

    interface Callback {
        fun onComplete(exitCode: Int)
        fun onError(e: Exception)
    }

    private val serviceScope = CoroutineScope(Dispatchers.Default + SupervisorJob())
    private var nodeJob: Job? = null

    /** Active watchdog slot. `getAndSet(null)` pairs "take ownership" with "clear" atomically. */
    private val startupWatchdogJob = AtomicReference<Job?>(null)
    private val dataDir: String = filesDir.absolutePath
    private val nodeProjectDir: File = File(filesDir, NODEJS_PROJECT_DIRNAME)
    private val jsFile: File = File(nodeProjectDir, NODEJS_PROJECT_INDEX_FILENAME)
    private val comapeoSocketFile: File = File(filesDir, ComapeoCoreService.COMAPEO_SOCKET_FILENAME)
    private val controlSocketFile: File = File(filesDir, ComapeoCoreService.CONTROL_SOCKET_FILENAME)
    private val sharedPrefsName = packageName + SHARED_PREFS_NAME_POSTFIX
    private val json = Json { encodeDefaults = true }
    private val ipcDeferred = CompletableDeferred<NodeJSIPC>()

    /** elapsedRealtime stamp from the activity intent, used to backdate boot.fgs-launch.
     *  `-1L` when the FGS was restarted by the system without an intent. */
    @Volatile
    var serviceStartElapsedMs: Long = -1L

    /** `boot.kind` tag value, set by [ComapeoCoreService] from the start intent's
     *  action (foreground / background / system restart). */
    @Volatile
    var bootKind: String = SentryTags.BOOT_KIND_SYSTEM_RESTART

    /** Sentry boot transaction handle. Opened in [start], closed in [applyAndEmit]
     *  on the first non-STARTING transition. `Any?` keeps io.sentry.* out of callers. */
    private val bootTx = AtomicReference<Any?>(null)

    /** In-flight FGS-side boot-phase spans keyed by phase
     *  (`fgs-launch`, `extract-assets`, `node-spawn`, `rootkey-load`). */
    private val bootSpans = java.util.concurrent.ConcurrentHashMap<String, Any>()

    /**
     * Single-slot derived-state observer, invoked outside the state lock on each
     * transition. [ComapeoCoreService] wires this to its self-terminate watchdog so
     * a terminal ERROR converges the FGS process to a restartable dead state
     * (see `ComapeoCoreService.onNodeStateChange`).
     */
    @Volatile
    var onStateChange: ((State) -> Unit)? = null

    /** Atomic state container — `getAndUpdate` is a CAS loop, so the
     *  `(nodeRuntime, backendState, stopRequested, state, lastError)` tuple is always coherent. */
    private val stateFlow = MutableStateFlow(ComponentSnapshot())

    fun getState(): State = stateFlow.value.state

    fun getLastError(): ErrorInfo? = stateFlow.value.lastError

    companion object {

        init {
            System.loadLibrary("comapeo-core-react-native")
        }

        @JvmStatic
        external fun initialize(dataDir: String)

        @JvmStatic
        external fun startNodeWithArguments(args: Array<String>): Int

        /** Companion delegate over the top-level [deriveLifecycleState]. Tests use
         *  the top-level helper to avoid the companion's `System.loadLibrary` init. */
        @JvmStatic
        fun deriveState(
            nodeRuntime: NodeRuntimeState,
            backendState: BackendState,
            stopRequested: Boolean,
        ): State = deriveLifecycleState(nodeRuntime, backendState, stopRequested)
    }

    init {
        initialize(dataDir)
        serviceScope.launch {
            withContext(Dispatchers.IO) {
                // Delete-before-bind: the socket filenames are a fixed cross-process
                // contract (ComapeoCoreModule connects to the same paths), so cleanup
                // is owned solely by this starting side. The shutdown paths must NOT
                // unlink them — a dying generation could otherwise remove sockets a
                // freshly cold-started process has already bound.
                deleteSocketFiles()
            }
            // Drives the rootkey handshake: on `started` ship the init frame from
            // RootKeyStore; on `ready` promote to STARTED via the derivation.
            ipcDeferred.complete(
                NodeJSIPC(
                    controlSocketFile,
                    onConnectionStateChange = { ipcState ->
                        // applyAndEmit captures the ERROR derived from a bad disconnect — crumb only here.
                        logCrumb(
                            SentryCategories.IPC,
                            "control IPC: ${ipcState.javaClass.simpleName}",
                            level = if (ipcState is NodeJSIPC.State.Error) "warning" else "info",
                            data = if (ipcState is NodeJSIPC.State.Error) {
                                mapOf("error" to (ipcState.exception.message ?: ipcState.exception.javaClass.simpleName))
                            } else emptyMap(),
                        )
                    },
                ) { message ->
                    handleControlMessage(message)
                },
            )
        }
    }

    /**
     * Mutates the component-state snapshot under a CAS loop, recomputes the
     * derived `state`, and fires `onStateChange` outside the lock if it changed.
     *
     * Caller-supplied `error` wins on a fresh ERROR; otherwise synthesise from
     * the component state so `getLastError()` is never silent on ERROR.
     */
    private fun applyAndEmit(
        error: ErrorInfo? = null,
        mutate: (ComponentSnapshot) -> ComponentSnapshot,
    ) {
        // `committed` is the snapshot the CAS loop actually wrote, no matter how many
        // retries. Re-reading stateFlow.value after could observe someone else's update.
        lateinit var committed: ComponentSnapshot
        val prev = stateFlow.getAndUpdate { snap ->
            val mutated = mutate(snap)
            val derived = deriveState(
                mutated.nodeRuntime,
                mutated.backendState,
                mutated.stopRequested,
            )
            // Compare against snap.state (pre-mutation) since mutated.copy preserves it.
            val newLastError = if (
                derived == State.ERROR && snap.state != State.ERROR
            ) {
                error
                    ?: (mutated.backendState as? BackendState.Error)
                        ?.let { ErrorInfo(it.phase, it.message) }
                    ?: (mutated.nodeRuntime as? NodeRuntimeState.Exited)
                        ?.takeIf { it.reason == ExitReason.UNEXPECTED }
                        ?.let {
                            ErrorInfo(
                                phase = "node-runtime-unexpected",
                                message = "Node thread exited unexpectedly with code ${it.code}",
                            )
                        }
                    ?: snap.lastError
            } else if (error != null) {
                error
            } else {
                mutated.lastError
            }
            val updated = mutated.copy(state = derived, lastError = newLastError)
            committed = updated
            updated
        }
        if (prev.state != committed.state) {
            if (prev.state == State.STARTING) cancelStartupWatchdog()

            // FGS-process transition breadcrumb; the main process emits its own.
            logCrumb(
                SentryCategories.STATE,
                "${prev.state} → ${committed.state}",
                level = if (committed.state == State.ERROR) "error" else "info",
                data = mapOf(
                    "from" to prev.state.name,
                    "to" to committed.state.name,
                    "backendState" to committed.backendState.javaClass.simpleName,
                    "nodeRuntime" to committed.nodeRuntime.javaClass.simpleName,
                    "stopRequested" to committed.stopRequested,
                ),
            )

            // Close the boot transaction on the first non-STARTING transition.
            // STOPPING/STOPPED-via-stop() bypass STARTED/ERROR so without the
            // cancelled case the txn leaks. `getAndSet(null)` guards double-finish.
            val terminalStatus = when (committed.state) {
                State.STARTED -> "ok"
                State.ERROR -> "internal_error"
                State.STOPPING, State.STOPPED -> "cancelled"
                State.STARTING -> null
            }
            if (terminalStatus != null) {
                // Drain in-flight phase spans BEFORE finishing the parent: Sentry's
                // Transaction.finish closes the tree, dropping later child finishes.
                val phases = bootSpans.keys.toList()
                for (phase in phases) {
                    bootSpans.remove(phase)?.let {
                        SentryFgsBridge.finishSpan(it, terminalStatus)
                    }
                }
                bootTx.getAndSet(null)?.let {
                    SentryFgsBridge.finishSpan(it, terminalStatus)
                }
            }

            onStateChange?.invoke(committed.state)
        }
    }

    /** `getAndSet` ensures only one thread owns the pre-swap ref — no double-cancel. */
    private fun cancelStartupWatchdog() {
        startupWatchdogJob.getAndSet(null)?.cancel()
    }

    /** Positionals are read by backend/index.js; `--sentry*` flags by backend/loader.mjs. */
    private fun buildBackendArgs(entryPath: String): Array<String> {
        // 4th positional: default config path, or "" when the app bundled
        // none. Always present so the `--sentry*` flags can't slip into it.
        val defaultConfigFile = File(nodeProjectDir, DEFAULT_CONFIG_FILENAME)
        val defaultConfigPath =
            if (defaultConfigFile.exists()) defaultConfigFile.absolutePath else ""
        // 5th positional: consumer's online map style URL, or "" when unset.
        val defaultOnlineStyleUrl =
            SentryConfig.readApplicationMetaDataString(this, META_DEFAULT_ONLINE_STYLE_URL) ?: ""
        val args = mutableListOf("node")
        // Debug builds ship the backend's `.map` colocated with the bundle
        // (src/debug only). `--enable-source-maps` (a Node runtime flag, so
        // it must precede the script path) makes Node remap stacks to
        // original positions in-process, so Sentry events are symbolicated
        // without a map upload. Release builds omit it and rely on
        // consumer-uploaded maps (debug-ID matched, symbolicated by Sentry).
        if (BuildConfig.DEBUG) {
            args += "--enable-source-maps"
        }
        args += listOf(
            entryPath,
            comapeoSocketFile.absolutePath,
            controlSocketFile.absolutePath,
            dataDir,
            defaultConfigPath,
            defaultOnlineStyleUrl,
        )
        sentryConfig?.let { cfg ->
            args += "--sentryDsn=${cfg.dsn}"
            args += "--sentryEnvironment=${cfg.environment}"
            args += "--sentryRelease=${cfg.release}"
            cfg.sampleRate?.let { args += "--sentrySampleRate=$it" }
            // Native owns the trace-sampling decision: full while the debug
            // window is on, else the plugin-configured cap (0 if unset). The
            // backend mirrors this value rather than re-deciding.
            val effectiveTracesSampleRate = if (debug) 1.0 else (cfg.tracesSampleRate ?: 0.0)
            args += "--sentryTracesSampleRate=$effectiveTracesSampleRate"
            cfg.rpcArgsBytes?.let { args += "--sentryRpcArgsBytes=$it" }
            if (cfg.enableLogs == true) args += "--sentryEnableLogs"
            sentryUserId?.let { args += "--sentryUserId=$it" }
            if (applicationUsageData) args += "--applicationUsageData"
            if (debug) args += "--debug"
            deviceTags?.let {
                args += "--deviceClass=${it.deviceClass}"
                args += "--osMajor=${it.osMajor}"
                args += "--platformTag=${it.platform}"
            }

            // Forward node-spawn's trace so Node spans nest under it; fall back to
            // the transaction defensively if node-spawn hasn't opened yet.
            val traceParent = bootSpans["node-spawn"] ?: bootTx.get()
            SentryFgsBridge.getTraceData(traceParent)?.let { (trace, baggage) ->
                args += "--sentryTrace=$trace"
                if (baggage != null) args += "--sentryBaggage=$baggage"
            }
        }
        return args.toTypedArray()
    }

    fun start(callback: Callback) {
        // Strict guard: start is only valid from STOPPED. Refusing ERROR is what makes
        // ERROR per-instance terminal — recovery is `destroy()` + new instance. iOS has
        // the same guard.
        val current = getState()
        if (current != State.STOPPED) {
            throw IllegalStateException(
                "Cannot start NodeJS service from state $current; must be STOPPED " +
                    "(call destroy() and create a new instance to recover from ERROR)",
            )
        }
        if (nodeJob != null) {
            throw IllegalStateException("NodeJS service is already running")
        }
        logCrumb(SentryCategories.BOOT, "start()")

        // Open boot transaction BEFORE STOPPED→STARTING — applyAndEmit's close-on-
        // terminal logic only fires when bootTx is non-null at transition time.
        // Backdate to startForegroundService so boot.fgs-launch sits at t=0.
        // Absence of the stamp means a system restart without an intent — no span.
        // boot.kind (set by the caller from the intent action) separates the
        // foreground / background / system-restart populations.
        val backdatedStart =
            if (serviceStartElapsedMs >= 0) serviceStartElapsedMs else null
        val tx = SentryFgsBridge.startBootTransaction(backdatedStart, bootKind)
        bootTx.set(tx)
        if (tx != null && backdatedStart != null) {
            SentryFgsBridge.startBootSpan(tx, "fgs-launch", backdatedStart)?.let {
                SentryFgsBridge.finishSpan(it, "ok")
            }
        }

        // Reset component state and transition STOPPED → STARTING via the derivation.
        // lastError is cleared as defense-in-depth in case the start-from-STOPPED invariant ever weakens.
        applyAndEmit { it.copy(
            nodeRuntime = NodeRuntimeState.Running,
            backendState = BackendState.Unknown,
            stopRequested = false,
            lastError = null,
        ) }

        // Arm the watchdog. The getState() recheck covers the narrow window where the
        // timer wakes after delay() but before cancellation has propagated.
        startupWatchdogJob.set(serviceScope.launch {
            delay(startupTimeoutMs)
            if (getState() == State.STARTING) {
                val info = ErrorInfo(
                    phase = "starting-timeout",
                    message = "Service did not reach STARTED within ${startupTimeoutMs}ms",
                )
                // Capture BEFORE applyAndEmit so the breadcrumb stack ends in STARTING, not ERROR.
                logCapture(
                    SentryCategories.STATE,
                    "comapeo: startup timeout fired",
                    level = "error",
                    tags = mapOf(
                        SentryTags.TIMEOUT to "startup",
                        SentryTags.PHASE to "starting-timeout",
                    ),
                )
                // Forward to backend so the main-app process gets the same error frame
                // via re-broadcast — keeps cross-process attribution intact when Node is hung.
                sendErrorNativeFrame(info.phase, info.message)
                applyAndEmit(error = info) {
                    it.copy(backendState = BackendState.Error(info.phase, info.message))
                }
            }
        })
        nodeJob = serviceScope.launch {
            // Tracks the in-flight phase for the catch below — set before each phase
            // so an exception in extract-assets doesn't attribute to node-runtime.
            var phase = "extract-assets"
            try {
                if (shouldCopyAssets()) {
                    // Only opened on first boot after install/update; presence in a trace
                    // identifies cold-start-after-update.
                    SentryFgsBridge.startBootSpan(bootTx.get(), "extract-assets")?.let {
                        bootSpans["extract-assets"] = it
                    }
                    withContext(Dispatchers.IO) {
                        nodeProjectDir.deleteRecursively()
                        copyAssetFolder(NODEJS_PROJECT_DIRNAME, nodeProjectDir)
                        // Mark only after the *whole* top-level copy finishes, so a kill
                        // mid-extraction leaves the marker unset and the next boot re-copies
                        // rather than spawning Node against a half-written bundle.
                        updateLastKnownVersion()
                        logCrumb(
                            SentryCategories.BOOT,
                            "asset copy complete",
                            data = mapOf("dir" to NODEJS_PROJECT_DIRNAME),
                        )
                    }
                    bootSpans.remove("extract-assets")?.let {
                        SentryFgsBridge.finishSpan(it, "ok")
                    }
                }

                phase = "node-spawn"
                // boot.node-spawn (stage B): JNI → V8 init → loader.mjs → Sentry.init
                // → `started` frame. Closed in handleControlMessage.
                SentryFgsBridge.startBootSpan(bootTx.get(), "node-spawn")?.let {
                    bootSpans["node-spawn"] = it
                }

                val exitCode = startNodeWithArguments(
                    buildBackendArgs(jsFile.absolutePath)
                )
                logCrumb(
                    SentryCategories.BOOT,
                    "node thread exited",
                    level = if (exitCode == 0) "info" else "warning",
                    data = mapOf("exitCode" to exitCode),
                )

                // REQUESTED = we asked (stop), backend announced (stopping), or backend
                // already reported an error. Anything else derives to ERROR.
                applyAndEmit { snap ->
                    val isRequested = snap.stopRequested ||
                        snap.backendState is BackendState.Stopping ||
                        snap.backendState is BackendState.Error
                    snap.copy(
                        nodeRuntime = NodeRuntimeState.Exited(
                            code = exitCode,
                            reason = if (isRequested) ExitReason.REQUESTED else ExitReason.UNEXPECTED,
                        ),
                    )
                }

                callback.onComplete(exitCode)
            } catch (e: Exception) {
                // Close the in-flight span with internal_error before applyAndEmit's
                // terminal logic drains it with the parent's status.
                bootSpans.remove(phase)?.let {
                    SentryFgsBridge.finishSpan(it, "internal_error")
                }
                // node-spawn failures map to the legacy `node-runtime` error phase
                // so the JS-adapter mapping and Sentry dashboards keep working.
                val (errPhase, errMessage, errSource) = when (phase) {
                    "extract-assets" -> Triple(
                        "extract-assets",
                        "Failed to extract Node.js assets",
                        "copy-asset-folder",
                    )
                    else -> Triple(
                        "node-runtime",
                        "Error starting node",
                        "startNodeWithArguments",
                    )
                }
                // captureException so the failure lands as a first-class event with the
                // full stack; applyAndEmit drives ERROR but JS only synthesises a thin Error.
                logException(
                    SentryCategories.BOOT,
                    e,
                    message = errMessage,
                    tags = mapOf(
                        SentryTags.PHASE to errPhase,
                        SentryTags.STATE to "ERROR",
                        SentryTags.SOURCE to errSource,
                    ),
                )
                val info = ErrorInfo(errPhase, e.message ?: e.javaClass.simpleName)
                // Mark runtime as exited alongside the backend-error transition; otherwise
                // a later applyAndEmit could re-derive against a stale `Running` triple.
                // Reason = REQUESTED keeps the derivation anchored on the backend error.
                applyAndEmit(error = info) {
                    it.copy(
                        backendState = BackendState.Error(info.phase, info.message),
                        nodeRuntime = NodeRuntimeState.Exited(
                            code = -1,
                            reason = ExitReason.REQUESTED,
                        ),
                    )
                }
                callback.onError(e)
            }
            // No socket cleanup here: the filenames are shared with a possible next
            // cold-started generation, whose delete-before-bind in init() owns cleanup.
            // Unlinking on the way out could remove sockets that generation just bound.
        }
    }

    /**
     * Test seam: drive the service to a terminal ERROR **without** exiting the
     * node thread, reproducing the FGS-local failure shape (startup-watchdog
     * timeout, rootkey load failure) that the self-terminate watchdog guards
     * against. Leaves `nodeRuntime` as-is (`Running`), so derivation lands in
     * ERROR while node stays alive — exactly the case where
     * `ComapeoCoreService.onNodeStateChange` must kill the process.
     *
     * Reached only via the debug-gated `Actions.SIMULATE_FATAL_ERROR` intent
     * (`BuildConfig.DEBUG`); not part of the production lifecycle. `otherwise =
     * PACKAGE_PRIVATE` so Lint allows the same-package call from the debug intent
     * handler in `ComapeoCoreService` while still flagging any wider production use.
     */
    @VisibleForTesting(otherwise = VisibleForTesting.PACKAGE_PRIVATE)
    fun forceFatalErrorForTesting() {
        val info = ErrorInfo("test-forced-error", "Forced fatal error (test seam)")
        applyAndEmit(error = info) {
            it.copy(backendState = BackendState.Error(info.phase, info.message))
        }
    }

    /** Routes raw control-socket frames into component-state mutations and the
     *  rootkey handshake. */
    private fun handleControlMessage(message: String) {
        when (val frame = ControlFrame.parse(message)) {
            ControlFrame.Started -> {
                logCrumb(SentryCategories.CONTROL, "received: started")
                bootSpans.remove("node-spawn")?.let {
                    SentryFgsBridge.finishSpan(it, "ok")
                }
                applyAndEmit { it.copy(backendState = BackendState.ControlBound) }
                sendInitFrame()
            }
            ControlFrame.Ready -> {
                logCrumb(SentryCategories.CONTROL, "received: ready")
                applyAndEmit { it.copy(backendState = BackendState.Ready) }
            }
            ControlFrame.Stopping -> {
                logCrumb(SentryCategories.CONTROL, "received: stopping")
                // Graceful shutdown — next we see the socket close; derivation maps
                // this to STOPPING and the subsequent runtime exit to STOPPED.
                applyAndEmit { it.copy(backendState = BackendState.Stopping) }
            }
            is ControlFrame.Error -> {
                logCrumb(
                    SentryCategories.CONTROL,
                    "received: error",
                    level = "error",
                    data = mapOf("phase" to frame.phase, "message" to frame.message),
                )
                val info = ErrorInfo(frame.phase, frame.message)
                applyAndEmit(error = info) {
                    it.copy(backendState = BackendState.Error(frame.phase, frame.message))
                }
            }
            is ControlFrame.SentryEvent -> {
                SentryFgsBridge.captureEventJson(frame.payloadJson)
            }
            is ControlFrame.SentryEnvelope -> {
                SentryFgsBridge.captureEnvelopeBase64(frame.data)
            }
            // Discovery-controller commands for the FGS-hosted BLE engine.
            // Other control clients (main-process module, iOS) no-op them.
            is ControlFrame.BleStart,
            is ControlFrame.BleAdvertise,
            is ControlFrame.BleStop,
            -> onBleControlFrame?.invoke(frame)
            is ControlFrame.Malformed -> {
                // Logged but not raised to ERROR — a single bad frame shouldn't take
                // down the lifecycle. The main-app Module surfaces `messageerror` separately.
                logCrumb(
                    SentryCategories.CONTROL,
                    "malformed control frame",
                    level = "warning",
                    data = mapOf("detail" to frame.detail),
                )
            }
        }
    }

    /**
     * Reads the rootkey, base64-encodes, and ships the init frame on the control
     * socket. Failures transition to ERROR and forward `error-native` to Node so
     * the main-app process sees the same phase via re-broadcast. The node thread
     * is left alive — recovery (restart FGS, prompt user, …) is the application's
     * responsibility, exposed via the JS `stateChange` event.
     *
     * Best-effort zero of the ByteArray after encoding; the base64 string still
     * lives in the JVM string pool until GC.
     */
    private fun sendInitFrame() {
        val rootkeyLoadSpan = SentryFgsBridge.startBootSpan(bootTx.get(), "rootkey-load")
        if (rootkeyLoadSpan != null) {
            bootSpans["rootkey-load"] = rootkeyLoadSpan
        }
        val rootKeyBytes: ByteArray = try {
            val result = RootKeyStore(applicationContext).loadOrInitialize()
            bootSpans.remove("rootkey-load")?.let { sp ->
                SentryFgsBridge.setSpanData(sp, "generated", result.generated)
                SentryFgsBridge.finishSpan(sp, "ok")
            }
            result.key
        } catch (e: Exception) {
            // FGS-scope capture; the same exception is re-captured on the main-process
            // JS adapter via error-native re-broadcast — Sentry de-dupes by fingerprint.
            logException(
                SentryCategories.BOOT,
                e,
                message = "Failed to load rootkey",
                tags = mapOf(
                    SentryTags.PHASE to "rootkey",
                    SentryTags.STATE to "ERROR",
                    SentryTags.SOURCE to "rootkey-store",
                ),
            )
            bootSpans.remove("rootkey-load")?.let { sp ->
                SentryFgsBridge.finishSpan(sp, "internal_error")
            }
            val info = ErrorInfo("rootkey", e.message ?: e.javaClass.simpleName)
            sendErrorNativeFrame(info.phase, info.message)
            applyAndEmit(error = info) {
                it.copy(backendState = BackendState.Error(info.phase, info.message))
            }
            return
        }
        val b64 = Base64.encodeToString(rootKeyBytes, Base64.NO_WRAP)
        rootKeyBytes.fill(0)
        val frame = "{\"type\":\"init\",\"rootKey\":\"$b64\"}"
        serviceScope.launch {
            ipcDeferred.await().sendMessage(frame)
            logCrumb(SentryCategories.BOOT, "init frame sent")
        }
    }

    /**
     * Sends `{type:"error-native",phase,message}` to Node for cross-process
     * attribution. The backend re-broadcasts as an `error` frame to all control
     * clients and exits 1, so the main-app process sees the actual phase rather
     * than hanging at STARTING when the FGS knows it has failed but Node is
     * stuck on `await initPromise`.
     *
     * Best-effort: fires async, bounded by [SEND_ERROR_NATIVE_TIMEOUT_MS].
     */
    private fun sendErrorNativeFrame(phase: String, message: String) {
        val payload = json.encodeToString(
            ErrorNativeMessage(phase = phase, message = message),
        )
        serviceScope.launch {
            try {
                val ipc = withTimeoutOrNull(SEND_ERROR_NATIVE_TIMEOUT_MS) {
                    ipcDeferred.await()
                }
                if (ipc == null) {
                    // Warning, not error — original cause was captured FGS-side; this
                    // only degrades attribution to the synthetic node-runtime-unexpected.
                    logCapture(
                        SentryCategories.IPC,
                        "comapeo: error-native frame dropped (phase=$phase)",
                        level = "warning",
                        tags = mapOf(
                            SentryTags.TIMEOUT to "errorNativeForward",
                            SentryTags.PHASE to phase,
                        ),
                    )
                    return@launch
                }
                ipc.sendMessage(payload)
                log("Sent error-native frame to backend (phase=$phase)")
            } catch (e: Exception) {
                Log.w(TAG, "Failed to send error-native frame", e)
            }
        }
    }

    /**
     * Sink for the backend's BLE engine commands
     * (`ble-start`/`ble-advertise`/`ble-stop`). Set by
     * [ComapeoCoreService], which owns the engine. Invoked on the
     * control-IPC coroutine — handlers must be quick and thread-safe.
     */
    var onBleControlFrame: ((ControlFrame) -> Unit)? = null

    /**
     * Best-effort fire-and-forget control frame to the backend — the
     * transport for the FGS-hosted BLE engine's `ble-sighting` /
     * `ble-status` frames. Same delivery model as
     * [sendErrorNativeFrame]: bounded wait for the socket, drop on
     * timeout/failure. BLE frames are inherently lossy (the next
     * sighting/status re-carries the state), so a drop needs no
     * capture — just a log.
     */
    fun sendControlFrame(frame: String) {
        serviceScope.launch {
            try {
                val ipc = withTimeoutOrNull(SEND_ERROR_NATIVE_TIMEOUT_MS) {
                    ipcDeferred.await()
                } ?: return@launch
                ipc.sendMessage(frame)
            } catch (e: Exception) {
                Log.w(TAG, "Failed to send control frame", e)
            }
        }
    }

    suspend fun stop() {
        // Strict guard: stop only valid from STARTING/STARTED. Refusing ERROR keeps
        // ERROR per-instance terminal for the public API (callers use destroy() to
        // release resources). The FGS teardown path uses [stopForTeardown] instead,
        // which drains gracefully even from ERROR.
        val current = getState()
        if (current != State.STARTING && current != State.STARTED) {
            log("Cannot stop NodeJS service from state $current (not STARTING/STARTED)")
            return
        }
        drainNode()
    }

    /**
     * Best-effort graceful drain for FGS process teardown. Ships the shutdown
     * frame and joins the node thread so the backend closes
     * MapeoManager/SQLite/fastify/sockets and exits on its own, instead of being
     * SIGKILLed by `Process.killProcess`.
     *
     * Unlike [stop] this has no lifecycle-state guard, so the self-terminate path
     * — which fires from ERROR with the node thread still alive, whose event loop
     * can still service the shutdown frame even while parked on `await initPromise`
     * — drains gracefully too. The drain is skipped only when the runtime has
     * already exited (crash / clean exit), where there is nothing left to drain.
     * The caller ([ComapeoCoreService.onDestroy]) bounds this with a timeout and
     * force-kills on expiry, so a wedged node can't block teardown.
     */
    suspend fun stopForTeardown() {
        if (stateFlow.value.nodeRuntime !is NodeRuntimeState.Running) {
            log("stopForTeardown: node runtime already exited, nothing to drain")
            nodeJob = null
            return
        }
        drainNode()
    }

    /** Ships `{type:"shutdown"}` and joins the node thread. Shared by the guarded
     *  public [stop] and the guard-less [stopForTeardown]. */
    private suspend fun drainNode() {
        if (nodeJob == null) {
            log("NodeJS service is not running, nothing to stop")
            return
        }
        applyAndEmit { it.copy(stopRequested = true) }
        try {
            val message = json.encodeToString(ShutdownMessage())
            val ipc = ipcDeferred.await()
            ipc.sendMessage(message)
            logCrumb(SentryCategories.STATE, "shutdown frame sent")
            nodeJob?.join()
        } catch (e: Exception) {
            logCrumb(
                SentryCategories.STATE,
                "drainNode() failed: ${e.message}",
                level = "warning",
            )
            nodeJob?.cancel()
        } finally {
            nodeJob = null
            if (ipcDeferred.isCompleted) {
                ipcDeferred.await().disconnect()
            }
        }
    }

    fun destroy() {
        logCrumb(SentryCategories.STATE, "destroy()")
        // No socket cleanup here (see start()'s finally): the next cold-started
        // generation's init() deletes-before-bind, and unlinking the shared-name
        // sockets on the way out could remove ones that generation already bound.
        nodeJob?.cancel()
        serviceScope.cancel()
        // Force a clean STOPPED (mirrors iOS `cleanup()`). lastError is preserved
        // so callers can inspect why this instance is being destroyed.
        applyAndEmit {
            it.copy(
                nodeRuntime = NodeRuntimeState.Exited(code = 0, reason = ExitReason.REQUESTED),
                backendState = BackendState.Unknown,
                stopRequested = true,
            )
        }
    }

    private fun deleteSocketFiles() {
        comapeoSocketFile.delete()
        controlSocketFile.delete()
    }

    private fun shouldCopyAssets(): Boolean {
        val prefs = getSharedPreferences(sharedPrefsName, MODE_PRIVATE)
        val lastUpdateTime = prefs.getLong(APK_LAST_UPDATE_TIME_KEY, -1)
        val currentUpdateTime = packageManager.getPackageInfo(packageName, 0).lastUpdateTime
        return lastUpdateTime != currentUpdateTime
    }

    private fun updateLastKnownVersion() {
        val currentUpdateTime = packageManager.getPackageInfo(packageName, 0).lastUpdateTime
        getSharedPreferences(sharedPrefsName, MODE_PRIVATE)
            .edit {
                putLong(APK_LAST_UPDATE_TIME_KEY, currentUpdateTime)
            }
    }

    private suspend fun copyAssetFolder(srcDirname: String, destDir: File): Unit = coroutineScope {
        assets.list(srcDirname)?.forEach { file ->
            val srcPath = "$srcDirname/$file"
            val destFile = File(destDir, file)

            if (assets.list(srcPath)?.isNotEmpty() == true) {
                destFile.mkdirs()
                copyAssetFolder(srcPath, destFile)
            } else {
                destFile.parentFile?.mkdirs()
                assets.open(srcPath).use { input ->
                    destFile.outputStream().use { output ->
                        input.copyTo(output)
                    }
                }
            }
        }
    }
}
