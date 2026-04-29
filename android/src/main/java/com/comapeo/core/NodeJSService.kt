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
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File
import java.util.concurrent.atomic.AtomicReference

@Serializable
data class ShutdownMessage(val type: String = "shutdown")

const val APK_LAST_UPDATE_TIME_KEY = "apk_last_update_time"
const val SHARED_PREFS_NAME_POSTFIX = "_nodejs_preferences"
const val NODEJS_PROJECT_DIRNAME = "nodejs-project"
const val NODEJS_PROJECT_INDEX_FILENAME = "index.mjs"

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
     * Public lifecycle state mirroring iOS's `NodeJSService.State`. The FGS's
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
     * backend's `{type:"error",phase,message,stack?}` control frame.
     * `phase` mirrors the boot phase strings the backend tags errors with
     * (`listen-control`, `init`, `construct`, `runtime`).
     */
    data class ErrorInfo(val phase: String, val message: String)

    /**
     * Atomic snapshot of the lifecycle state plus the most recent error
     * detail. Stored together in a single `MutableStateFlow` so the
     * pair-update in `transitionToError` is naturally atomic — no
     * separate lock or two-step write is needed for observers to see a
     * consistent (state, lastError) view.
     */
    private data class StateSnapshot(
        val state: State,
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
    private val mediaSocketFile: File = File(filesDir, ComapeoCoreService.MEDIA_SOCKET_FILENAME)
    private val sharedPrefsName = packageName + SHARED_PREFS_NAME_POSTFIX
    private val json = Json { encodeDefaults = true }
    private val ipcDeferred = CompletableDeferred<NodeJSIPC>()

    /**
     * Single-slot state observer. The FGS routes transitions through here
     * to `ComapeoCoreService`, which broadcasts to the main app process via
     * the control socket's `started`/`ready` messages — JS side derives its
     * own state machine from those (no extra cross-process IPC needed).
     */
    @Volatile
    var onStateChange: ((State) -> Unit)? = null

    /**
     * Atomic state container. `MutableStateFlow.getAndUpdate` is a
     * CAS-loop, so concurrent transitions resolve in a defined order
     * and the `(state, lastError)` pair is always observed as a
     * matching unit. Replaces the explicit `synchronized` block that
     * the previous implementation used to coordinate the two fields.
     */
    private val stateFlow = MutableStateFlow(StateSnapshot(State.STOPPED))

    fun getState(): State = stateFlow.value.state

    fun getLastError(): ErrorInfo? = stateFlow.value.lastError

    private fun transitionState(to: State) {
        val prev = stateFlow.getAndUpdate { snap ->
            if (snap.state == to) snap else snap.copy(state = to)
        }
        if (prev.state == to) return
        log("NodeJSService state: ${prev.state} -> $to")
        if (prev.state == State.STARTING) cancelStartupWatchdog()
        onStateChange?.invoke(to)
    }

    /**
     * Sets `lastError` and transitions to ERROR atomically. The
     * `getAndUpdate` block is a CAS-loop so the (state, lastError)
     * pair always lands together. If already in ERROR, the captured
     * detail is still refreshed (a second error in the same session is
     * observable via `getLastError()`) but `onStateChange` is not
     * re-invoked.
     */
    private fun transitionToError(phase: String, message: String) {
        val info = ErrorInfo(phase, message)
        val prev = stateFlow.getAndUpdate { snap ->
            snap.copy(state = State.ERROR, lastError = info)
        }
        log("NodeJSService error ($phase): $message")
        if (prev.state == State.ERROR) return
        log("NodeJSService state: ${prev.state} -> ${State.ERROR}")
        if (prev.state == State.STARTING) cancelStartupWatchdog()
        onStateChange?.invoke(State.ERROR)
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

    companion object {

        init {
            System.loadLibrary("comapeo-core-react-native")
        }

        @JvmStatic
        external fun initialize(dataDir: String)

        @JvmStatic
        external fun startNodeWithArguments(args: Array<String>): Int
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
            // promote to STARTED.
            ipcDeferred.complete(
                NodeJSIPC(controlSocketFile) { message ->
                    handleControlMessage(message)
                },
            )
        }
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
        log("Starting NodeJS service")
        transitionState(State.STARTING)
        // Arm the startup watchdog. `delay()` respects coroutine
        // cancellation, so `cancelStartupWatchdog()` (called from
        // `transitionState` when leaving STARTING) reliably aborts the
        // job before it fires. The `getState()` recheck inside the
        // delay'd body covers the narrow window where the timer wakes
        // up after delay() but before its cancellation has propagated.
        startupWatchdogJob.set(serviceScope.launch {
            delay(startupTimeoutMs)
            if (getState() == State.STARTING) {
                transitionToError(
                    "starting-timeout",
                    "Service did not reach STARTED within ${startupTimeoutMs}ms",
                )
            }
        })
        nodeJob = serviceScope.launch {
            try {
                if (shouldCopyAssets()) {
                    withContext(Dispatchers.IO) {
                        nodeProjectDir.deleteRecursively()
                        copyAssetFolder(NODEJS_PROJECT_DIRNAME, nodeProjectDir)
                        log("Copied $NODEJS_PROJECT_DIRNAME into data directory")
                    }
                }

                val exitCode = startNodeWithArguments(
                    arrayOf(
                        "node",
                        jsFile.absolutePath,
                        comapeoSocketFile.absolutePath,
                        controlSocketFile.absolutePath,
                        dataDir,
                        mediaSocketFile.absolutePath,
                    )
                )
                log("NodeJS service completed with exit code $exitCode")
                callback.onComplete(exitCode)
            } catch (e: Exception) {
                Log.e(TAG, "Error starting node", e)
                transitionToError("node-runtime", e.message ?: e.javaClass.simpleName)
                callback.onError(e)
            } finally {
                deleteSocketFiles()
                if (getState() != State.ERROR) transitionState(State.STOPPED)
            }
        }
    }

    /**
     * Routes raw control-socket frames into lifecycle transitions and the
     * rootkey handshake. Frames are JSON of the shape `{"type":"<name>",…}`
     * (well-known names: `started`, `ready`, `error`). Parsing happens on
     * the IPC's receive coroutine; the parser cost is negligible and the
     * init-frame send is already async via `serviceScope.launch`, so there
     * is no ordering or throughput reason to avoid a real parser here.
     */
    private fun handleControlMessage(message: String) {
        log("Control IPC received: $message")
        when (val frame = ControlFrame.parse(message)) {
            ControlFrame.Started -> sendInitFrame()
            ControlFrame.Ready -> {
                if (getState() == State.STARTING) transitionState(State.STARTED)
            }
            is ControlFrame.Error -> transitionToError(frame.phase, frame.message)
            is ControlFrame.Malformed -> {
                // Logged but not raised to ERROR: the FGS-side state
                // derives from the backend's structured frames, and a
                // single bad frame should not tear down the FGS
                // lifecycle. The main-app Module surfaces `messageerror`
                // separately so application code can observe protocol
                // issues without losing service state.
                log("NodeJSService: ${frame.detail}")
            }
        }
    }

    /**
     * Reads the rootkey via `RootKeyStore`, base64-encodes, and ships the
     * init frame on the control socket. Failures here transition the
     * service to ERROR but deliberately do **not** tear down the node
     * thread: ERROR is observable by the application (via the JS
     * `stateChange` event) and recovery — restarting the FGS, prompting
     * the user, etc. — is the application's responsibility, not this
     * layer's. Tearing down here would mask the failure from any UI that
     * expects to read `getLastError()` between observing ERROR and
     * deciding what to do.
     *
     * The ByteArray is zeroed after encoding — best-effort, since the
     * encoded base64 string still lives in the JVM string pool until GC.
     */
    private fun sendInitFrame() {
        val rootKeyBytes: ByteArray = try {
            RootKeyStore(applicationContext).loadOrInitialize()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to load rootkey", e)
            transitionToError("rootkey", e.message ?: e.javaClass.simpleName)
            return
        }
        val b64 = Base64.encodeToString(rootKeyBytes, Base64.NO_WRAP)
        rootKeyBytes.fill(0)
        val frame = "{\"type\":\"init\",\"rootKey\":\"$b64\"}"
        serviceScope.launch {
            ipcDeferred.await().sendMessage(frame)
            log("Sent init frame to backend")
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
        transitionState(State.STOPPING)
        try {
            val message = json.encodeToString(ShutdownMessage())
            log(message)
            val ipc = ipcDeferred.await()
            ipc.sendMessage(message)
            log("Sent shutdown message to NodeJS service")
            nodeJob?.join()
            log("nodeJob completed")
        } catch (e: Exception) {
            log("Error during stop: ${e.message}")
            nodeJob?.cancel()
        } finally {
            nodeJob = null
            if (ipcDeferred.isCompleted) {
                ipcDeferred.await().disconnect()
            }
        }
    }

    fun destroy() {
        deleteSocketFiles()
        nodeJob?.cancel()
        serviceScope.cancel()
        transitionState(State.STOPPED)
        log("NodeJS service destroyed")
    }

    private fun deleteSocketFiles() {
        comapeoSocketFile.delete()
        controlSocketFile.delete()
        mediaSocketFile.delete()
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
