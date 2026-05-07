package com.comapeo.core

import android.content.ContextWrapper
import android.util.Base64
import android.util.Log
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
 * Frame native sends to Node when an FGS-side local failure (rootkey
 * load, startup watchdog timeout) needs cross-process attribution. The
 * backend's `error-native` handler re-broadcasts via `broadcastError`
 * and exits, so the main-app process sees a real `error` frame with
 * the actual phase rather than a generic "unexpected disconnect".
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
const val NODEJS_PROJECT_INDEX_FILENAME = "index.mjs"

/**
 * Bound on `ipcDeferred.await()` inside `sendErrorNativeFrame`. If the
 * FGS fails before NodeJSIPC is constructed, the deferred never
 * completes and an unbounded await would pin a coroutine. Two seconds
 * is generous for an in-process completion that normally happens in
 * milliseconds; on miss, the frame is logged as dropped.
 */
private const val SEND_ERROR_NATIVE_TIMEOUT_MS = 2_000L

@Suppress("KotlinJniMissingFunction")
class NodeJSService(
    context: android.content.Context,
    /**
     * Maximum milliseconds the service may stay in STARTING before the
     * watchdog forces ERROR. Configurable so tests (and slow CI) can
     * tighten or relax it. Default 30 s covers cold device boot plus
     * addon dlopens (sodium-native + better-sqlite3 dominate) with
     * margin; without the watchdog, a backend hang would leave STARTING
     * as a black hole.
     */
    private val startupTimeoutMs: Long = 30_000,
) : ContextWrapper(context) {
    /**
     * Public lifecycle state mirroring iOS's `NodeJSService.State`. This
     * is a *derived* value — see `deriveState` for the inputs. The FGS's
     * `ComapeoCoreService` forwards transitions to the JS layer via the
     * Expo module so callers can render UI feedback. See issue #29.
     *
     * State semantics:
     * - STOPPED  — initial; not running.
     * - STARTING — Node process has been spawned (or is about to be) AND
     *              we're awaiting the backend's `ready` broadcast on the
     *              control socket. The rootkey hand-off happens in this
     *              window: backend sends `started`, FGS sends the init
     *              frame with the rootkey, backend constructs MapeoManager
     *              and replies with `ready`.
     * - STARTED  — RPC is safe to use. The comapeo socket is bound.
     * - STOPPING — graceful shutdown initiated.
     * - ERROR    — observable failure (rootkey load failed, backend boot
     *              error, shutdown timed out, IPC connect error,
     *              malformed control frame). `getLastError()` carries
     *              the structured detail.
     *
     * **ERROR is per-instance terminal.** Once an instance enters ERROR,
     * `start()` and `stop()` are refused — the application must
     * `destroy()` the instance and create a fresh `NodeJSService`. On
     * Android this is the natural model: the FGS creates a new
     * `NodeJSService` in `onCreate` for every service start, so a
     * recovery flow is "stop the FGS, start it again" and a brand-new
     * instance gets STOPPED → STARTING. The node thread may still be
     * alive when ERROR is set (this layer does not tear it down on
     * error); `destroy()` is what releases it.
     */
    enum class State {
        STOPPED, STARTING, STARTED, STOPPING, ERROR
    }

    /**
     * Structured detail attached to ERROR transitions sourced from the
     * backend's `{type:"error",phase,message,stack?}` control frame, or
     * synthesized when the node thread exits unexpectedly without a
     * frame. `phase` mirrors the boot phase strings the backend tags
     * errors with (`listen-control`, `init`, `construct`, `runtime`)
     * plus the local `rootkey`, `starting-timeout`, `node-runtime`,
     * `node-runtime-unexpected`.
     */
    data class ErrorInfo(val phase: String, val message: String)

    /**
     * Whether the Node.js runtime thread is running, not yet started, or
     * has exited. The exit reason distinguishes a graceful exit (we asked
     * for it via `stop()` or saw a `stopping` frame) from an unexpected
     * one (thread returned without us asking) — the latter derives to
     * ERROR so a crash in a native addon or an unrecoverable
     * `process.abort()` is observable as ERROR rather than STOPPED.
     */
    sealed class NodeRuntimeState {
        object NotRunning : NodeRuntimeState()
        object Running : NodeRuntimeState()
        data class Exited(val code: Int, val reason: ExitReason) : NodeRuntimeState()
    }

    enum class ExitReason {
        /**
         * `stop()` was called or the backend broadcast `{type:"stopping"}`
         * before the thread exited. The graceful path.
         */
        REQUESTED,

        /**
         * The thread returned without a preceding stop signal. Derives
         * to ERROR via `deriveState`.
         */
        UNEXPECTED,
    }

    /**
     * What the backend has told us via control-socket frames, plus local
     * failures that share the same conceptual slot (rootkey load,
     * watchdog timeout). Mirrors the boot phases the backend tags errors
     * with, with `Unknown` for "no frames yet" and `ControlBound` for
     * "received `started`, awaiting init→ready".
     */
    sealed class BackendState {
        object Unknown : BackendState()
        object ControlBound : BackendState()
        object Ready : BackendState()
        object Stopping : BackendState()
        data class Error(val phase: String, val message: String) : BackendState()
    }

    /**
     * Atomic snapshot of the three component states plus the derived
     * `state` and the most recent error detail. Stored together in a
     * single `MutableStateFlow` so concurrent CAS-loops update the
     * tuple as a unit and observers always see a matching `(state,
     * lastError)` view.
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

    /**
     * Active startup-watchdog job slot. Launched in `start()`, cancelled
     * by `cancelWatchdog()` whenever the service leaves STARTING.
     * Holds an `AtomicReference` so `getAndSet(null)` is a single
     * thread-safe operation pairing "take ownership of the current
     * watchdog ref" with "clear the slot" — avoids any window where
     * two threads could both observe and try to cancel the same job.
     */
    private val startupWatchdogJob = AtomicReference<Job?>(null)
    private val dataDir: String = filesDir.absolutePath
    private val nodeProjectDir: File = File(filesDir, NODEJS_PROJECT_DIRNAME)
    private val jsFile: File = File(nodeProjectDir, NODEJS_PROJECT_INDEX_FILENAME)
    private val comapeoSocketFile: File = File(filesDir, ComapeoCoreService.COMAPEO_SOCKET_FILENAME)
    private val controlSocketFile: File = File(filesDir, ComapeoCoreService.CONTROL_SOCKET_FILENAME)
    private val sharedPrefsName = packageName + SHARED_PREFS_NAME_POSTFIX
    private val json = Json { encodeDefaults = true }
    private val ipcDeferred = CompletableDeferred<NodeJSIPC>()

    /**
     * Sentry boot transaction handle. Opened in [start], closed in
     * [applyAndEmit] on the first non-STARTING transition. `Any?`
     * keeps `io.sentry.*` types out of this file.
     */
    private val bootTx = AtomicReference<Any?>(null)

    /**
     * In-flight boot-phase spans keyed by phase. The FGS process
     * observes `rootkey-load` and `init-frame` directly; the
     * remaining phases (`listen-control`, `construct`,
     * `ipc-connect`) live in the Node-side boot once Phase 3
     * wires them up via distributed tracing.
     */
    private val bootSpans = java.util.concurrent.ConcurrentHashMap<String, Any>()

    /**
     * Single-slot state observer. The FGS routes transitions through here
     * to `ComapeoCoreService`, which broadcasts to the main app process via
     * the control socket's `started`/`ready`/`stopping`/`error` messages —
     * JS side derives its own state machine from those (no extra
     * cross-process IPC needed beyond the `error-native` channel).
     */
    @Volatile
    var onStateChange: ((State) -> Unit)? = null

    /**
     * Atomic state container. `MutableStateFlow.getAndUpdate` is a
     * CAS-loop, so concurrent transitions resolve in a defined order
     * and the entire `(nodeRuntime, backendState, stopRequested,
     * state, lastError)` tuple is always observed as a matching unit.
     */
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

        /**
         * Pure function: maps the three component states to the public
         * `State`. The decision order lives on [deriveLifecycleState]
         * — single source of truth. This delegate exists so the
         * companion can expose it as a [@JvmStatic] entry point;
         * tests prefer the top-level helper to avoid triggering
         * the companion's `System.loadLibrary` init.
         */
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
                log("Deleting socket files if they exist")
                deleteSocketFiles()
                log("Deleted socket files")
            }
            // Drives the rootkey handshake: on `started` we ship the init
            // frame with the bytes from RootKeyStore; on `ready` we
            // promote to STARTED (via the derivation).
            ipcDeferred.complete(
                NodeJSIPC(
                    controlSocketFile,
                    onConnectionStateChange = { ipcState ->
                        // applyAndEmit already captures the
                        // exception on the ERROR state derived
                        // from a bad disconnect — crumb only.
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
     * Mutates the component-state snapshot under a CAS-loop, recomputes
     * the derived `state`, and fires `onStateChange` outside the lock if
     * the derived value changed.
     *
     * `error` is set when the transition has a caller-supplied error
     * detail (most error paths). When the derived state lands in ERROR
     * *without* a caller-supplied detail (e.g. an unexpected
     * `nodeRuntime.exited`), a synthetic `ErrorInfo` is generated from
     * the offending component so `getLastError()` is never silent on
     * an ERROR.
     */
    private fun applyAndEmit(
        error: ErrorInfo? = null,
        mutate: (ComponentSnapshot) -> ComponentSnapshot,
    ) {
        // `committed` captures the snapshot the CAS loop actually
        // wrote, regardless of how many retries happened. Using it
        // (rather than re-reading stateFlow.value after) guarantees
        // we compare prev → committed for OUR transition only, even
        // if another thread updates the flow in between.
        lateinit var committed: ComponentSnapshot
        val prev = stateFlow.getAndUpdate { snap ->
            val mutated = mutate(snap)
            val derived = deriveState(
                mutated.nodeRuntime,
                mutated.backendState,
                mutated.stopRequested,
            )
            // Capture lastError when entering ERROR. Caller-supplied
            // detail wins; otherwise synthesize from the component
            // state so getLastError() is never silent on an ERROR.
            // Compare against `snap.state` (the pre-mutation value)
            // since `mutated.copy(...)` preserves that field.
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

            // FGS-process state-transition breadcrumb. The main
            // process emits its own via src/sentry.ts.
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

            // Close the boot transaction on the first terminal-or-
            // cancelling transition. STOPPING/STOPPED-via-stop()
            // bypass STARTED/ERROR entirely per
            // `deriveLifecycleState` — without the cancelled case
            // the txn leaks. `getAndSet(null)` ensures a single
            // owner so subsequent transitions can't double-finish.
            val terminalStatus = when (committed.state) {
                State.STARTED -> "ok"
                State.ERROR -> "internal_error"
                State.STOPPING, State.STOPPED -> "cancelled"
                State.STARTING -> null
            }
            if (terminalStatus != null) {
                bootTx.getAndSet(null)?.let {
                    SentryFgsBridge.finishSpan(it, terminalStatus)
                }
                // Drain any in-flight phase spans alongside the
                // transaction — they share the lifecycle and would
                // otherwise stay open indefinitely. Pre-STARTED
                // closure uses the same status as the parent so
                // the dashboard doesn't show "boot.rootkey-load
                // succeeded" alongside "comapeo.boot cancelled".
                val phases = bootSpans.keys.toList()
                for (phase in phases) {
                    bootSpans.remove(phase)?.let {
                        SentryFgsBridge.finishSpan(it, terminalStatus)
                    }
                }
            }

            onStateChange?.invoke(committed.state)
        }
    }

    /**
     * Atomically swaps the watchdog slot to null and cancels whatever
     * was there. Safe under concurrent calls because `getAndSet` is a
     * single atomic operation: only one thread takes ownership of the
     * pre-swap reference, so a job is never cancelled twice and the
     * slot never re-references a cancelled job.
     */
    private fun cancelStartupWatchdog() {
        startupWatchdogJob.getAndSet(null)?.cancel()
    }

    fun start(callback: Callback) {
        // Strict guard: start is only valid from STOPPED. Refusing
        // STARTING/STARTED is the existing behaviour (nodeJob check
        // below); refusing STOPPING/ERROR is the new behaviour that
        // makes ERROR per-instance terminal — a caller that sees ERROR
        // must `destroy()` and create a new instance to recover, which
        // is what the FGS lifecycle does naturally on Android. iOS has
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

        // Open boot transaction BEFORE the STOPPED→STARTING
        // transition; applyAndEmit's close-on-terminal logic only
        // fires when bootTx is non-null at transition time.
        bootTx.set(SentryFgsBridge.startBootTransaction())

        // Reset component state for a fresh start cycle and transition
        // STOPPED → STARTING via the derivation. `lastError` is cleared
        // explicitly: today this only matters as defense-in-depth (the
        // start guard above refuses ERROR, so fresh start is reachable
        // only from STOPPED, where lastError is null in clean cycles)
        // but it removes any chance of a stale ErrorInfo leaking across
        // start cycles if that invariant ever weakens.
        applyAndEmit { it.copy(
            nodeRuntime = NodeRuntimeState.Running,
            backendState = BackendState.Unknown,
            stopRequested = false,
            lastError = null,
        ) }

        // Arm the startup watchdog. `delay()` respects coroutine
        // cancellation, so `cancelStartupWatchdog()` (called when
        // applyAndEmit observes a leave from STARTING) reliably aborts
        // the job before it fires. The `getState()` recheck inside the
        // delay'd body covers the narrow window where the timer wakes
        // up after delay() but before its cancellation has propagated.
        startupWatchdogJob.set(serviceScope.launch {
            delay(startupTimeoutMs)
            if (getState() == State.STARTING) {
                val info = ErrorInfo(
                    phase = "starting-timeout",
                    message = "Service did not reach STARTED within ${startupTimeoutMs}ms",
                )
                // Capture BEFORE the applyAndEmit that drives ERROR
                // so the breadcrumb stack ends with STARTING (the
                // in-flight state) rather than the terminal ERROR.
                logCapture(
                    SentryCategories.STATE,
                    "comapeo: startup timeout fired",
                    level = "error",
                    tags = mapOf(
                        SentryTags.TIMEOUT to "startup",
                        SentryTags.PHASE to "starting-timeout",
                        SentryTags.TIMEOUT_MS to startupTimeoutMs.toString(),
                    ),
                )
                // Send error-native to backend so the main-app process
                // gets the same error frame via re-broadcast — keeps
                // cross-process error attribution intact when the
                // FGS-side knows about the failure but Node is hung.
                sendErrorNativeFrame(info.phase, info.message)
                applyAndEmit(error = info) {
                    it.copy(backendState = BackendState.Error(info.phase, info.message))
                }
            }
        })
        nodeJob = serviceScope.launch {
            try {
                if (shouldCopyAssets()) {
                    withContext(Dispatchers.IO) {
                        nodeProjectDir.deleteRecursively()
                        copyAssetFolder(NODEJS_PROJECT_DIRNAME, nodeProjectDir)
                        logCrumb(
                            SentryCategories.BOOT,
                            "asset copy complete",
                            data = mapOf("dir" to NODEJS_PROJECT_DIRNAME),
                        )
                    }
                }

                val exitCode = startNodeWithArguments(
                    arrayOf(
                        "node",
                        jsFile.absolutePath,
                        comapeoSocketFile.absolutePath,
                        controlSocketFile.absolutePath,
                        dataDir,
                    )
                )
                logCrumb(
                    SentryCategories.BOOT,
                    "node thread exited",
                    level = if (exitCode == 0) "info" else "warning",
                    data = mapOf("exitCode" to exitCode),
                )

                // Classify the exit. "Requested" means we asked for it
                // (stop()) or the backend announced it (`stopping`) or
                // the backend already reported an error. Anything else
                // is unexpected — a crash in a native addon, a
                // `process.abort()` we didn't see coming, a SIGSEGV —
                // and derives to ERROR with a synthesized phase.
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
                // captureException so the runtime-launch failure is
                // a first-class Sentry event with the full stack;
                // applyAndEmit below drives ERROR but the JS adapter
                // only synthesises a thin Error from the phase/msg.
                logException(
                    SentryCategories.BOOT,
                    e,
                    message = "Error starting node",
                    tags = mapOf(
                        SentryTags.PHASE to "node-runtime",
                        SentryTags.STATE to "ERROR",
                        SentryTags.SOURCE to "startNodeWithArguments",
                    ),
                )
                val info = ErrorInfo("node-runtime", e.message ?: e.javaClass.simpleName)
                // The thread has unwound, so mark the runtime as exited
                // alongside the backend-error transition. Without this,
                // the component triple is left inconsistent (runtime
                // still Running) — visible state derives correctly via
                // the backend-error rule, but a later applyAndEmit that
                // mutates other fields would re-derive against a stale
                // runtime. Reason is REQUESTED to keep the derivation
                // anchored on the explicit backend error.
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
            } finally {
                deleteSocketFiles()
            }
        }
    }

    /**
     * Routes raw control-socket frames into component-state mutations
     * and the rootkey handshake. Frames are JSON of the shape
     * `{"type":"<name>",…}` (well-known names: `started`, `ready`,
     * `stopping`, `error`). Parsing happens on the IPC's receive
     * coroutine; the parser cost is negligible and the init-frame send
     * is already async via `serviceScope.launch`, so there is no
     * ordering or throughput reason to avoid a real parser here.
     */
    private fun handleControlMessage(message: String) {
        when (val frame = ControlFrame.parse(message)) {
            ControlFrame.Started -> {
                logCrumb(SentryCategories.CONTROL, "received: started")
                applyAndEmit { it.copy(backendState = BackendState.ControlBound) }
                sendInitFrame()
            }
            ControlFrame.Ready -> {
                logCrumb(SentryCategories.CONTROL, "received: ready")
                // `ready` is the natural close point for the
                // boot.init-frame span opened in sendInitFrame().
                bootSpans.remove("init-frame")?.let {
                    SentryFgsBridge.finishSpan(it, "ok")
                }
                applyAndEmit { it.copy(backendState = BackendState.Ready) }
            }
            ControlFrame.Stopping -> {
                logCrumb(SentryCategories.CONTROL, "received: stopping")
                // Backend is gracefully shutting down. The next thing
                // we'll see is the socket close; the derivation maps
                // this to STOPPING and the subsequent runtime exit
                // will derive to STOPPED (via Exited(_, REQUESTED)).
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
            is ControlFrame.Malformed -> {
                // Logged but not raised to ERROR: a single bad frame
                // shouldn't take down the lifecycle. The main-app
                // Module surfaces `messageerror` separately.
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
     * Reads the rootkey via `RootKeyStore`, base64-encodes, and ships the
     * init frame on the control socket. Failures here transition the
     * service to ERROR via `backendState = .error(...)` and additionally
     * send `error-native` to Node so the main-app process gets the same
     * error attribution via the re-broadcast path. We deliberately do
     * **not** tear down the node thread: ERROR is observable by the
     * application (via the JS `stateChange` event) and recovery —
     * restarting the FGS, prompting the user, etc. — is the
     * application's responsibility, not this layer's.
     *
     * The ByteArray is zeroed after encoding — best-effort, since the
     * encoded base64 string still lives in the JVM string pool until GC.
     */
    private fun sendInitFrame() {
        val rootkeyLoadSpan = SentryFgsBridge.startBootSpan(bootTx.get(), "rootkey-load")
        if (rootkeyLoadSpan != null) {
            bootSpans["rootkey-load"] = rootkeyLoadSpan
        }
        val rootKeyBytes: ByteArray = try {
            RootKeyStore(applicationContext).loadOrInitialize().also {
                bootSpans.remove("rootkey-load")?.let { sp ->
                    SentryFgsBridge.finishSpan(sp, "ok")
                }
            }
        } catch (e: Exception) {
            // FGS-scope capture. The same exception is forwarded to
            // Node via sendErrorNativeFrame and re-broadcast, then
            // re-captured by the main-process JS adapter with
            // proc:main — Sentry de-dupes via fingerprinting.
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
        // boot.init-frame span: from "init sent" to "ready
        // received" (closed in handleControlMessage).
        SentryFgsBridge.startBootSpan(bootTx.get(), "init-frame")?.let {
            bootSpans["init-frame"] = it
        }
        serviceScope.launch {
            ipcDeferred.await().sendMessage(frame)
            logCrumb(SentryCategories.BOOT, "init frame sent")
        }
    }

    /**
     * Cross-process error attribution: send `{type:"error-native",phase,
     * message}` to Node. The backend's `error-native` handler routes to
     * `handleFatal`, which broadcasts an `error` frame to all control
     * clients (including the main-app process's read-only observer) and
     * exits 1 after a 100ms flush window.
     *
     * Without this, an FGS-side rootkey or watchdog failure leaves Node
     * hanging on `await initPromise` (no backend timeout on init) while
     * the main-app process stays at STARTING forever — the FGS knows it
     * has failed but has no way to tell the main app.
     *
     * Best-effort: fires async and returns immediately. Bounded by
     * [SEND_ERROR_NATIVE_TIMEOUT_MS] so a never-completing
     * `ipcDeferred` (e.g. an FGS that fails before the IPC is
     * constructed) doesn't pin a coroutine forever — it's logged as
     * dropped after the timeout. In that case the FGS is also losing
     * the only channel to the main-app process, so the dropped frame
     * is no worse than today.
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
                    // Warning rather than error: the FGS already
                    // captured the original cause locally; this
                    // only degrades cross-process attribution to
                    // the synthetic `node-runtime-unexpected` phase
                    // the main-app process derives from the
                    // control-socket close.
                    logCapture(
                        SentryCategories.IPC,
                        "comapeo: error-native frame dropped (phase=$phase)",
                        level = "warning",
                        tags = mapOf(
                            SentryTags.TIMEOUT to "errorNativeForward",
                            SentryTags.PHASE to phase,
                            SentryTags.TIMEOUT_MS to SEND_ERROR_NATIVE_TIMEOUT_MS.toString(),
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

    suspend fun stop() {
        // Strict guard: stop is only valid from STARTING/STARTED.
        // Refusing STOPPED/STOPPING is "nothing to do, already there".
        // Refusing ERROR is what makes ERROR per-instance terminal —
        // a stop() on ERROR would otherwise transition ERROR -> STOPPING,
        // a transition that doesn't map to any clear semantic.
        // Callers that need to release resources after ERROR should
        // call `destroy()`. iOS has the same guard.
        val current = getState()
        if (current != State.STARTING && current != State.STARTED) {
            log("Cannot stop NodeJS service from state $current (not STARTING/STARTED)")
            return
        }
        if (nodeJob == null) {
            log("NodeJS service is not running, nothing to stop")
            return
        }
        // Mark intent — derivation moves toward STOPPING, then STOPPED
        // once the runtime exits.
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
                "stop() failed: ${e.message}",
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
        deleteSocketFiles()
        nodeJob?.cancel()
        serviceScope.cancel()
        // Force a clean STOPPED via the same trick `cleanup()` uses on
        // iOS: assert intent, mark the runtime as exited, drop any
        // backend-side state. `lastError` is preserved for any caller
        // that wants to inspect why this instance is being destroyed.
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
        log("Last update time: $lastUpdateTime, current update time: $currentUpdateTime")
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
        updateLastKnownVersion()
    }
}
