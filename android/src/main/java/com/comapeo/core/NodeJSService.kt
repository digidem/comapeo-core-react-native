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
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File

@Serializable
data class ShutdownMessage(val type: String = "shutdown")

const val APK_LAST_UPDATE_TIME_KEY = "apk_last_update_time"
const val SHARED_PREFS_NAME_POSTFIX = "_nodejs_preferences"
const val NODEJS_PROJECT_DIRNAME = "nodejs-project"
const val NODEJS_PROJECT_INDEX_FILENAME = "index.mjs"

@Suppress("KotlinJniMissingFunction")
class NodeJSService(context: android.content.Context) : ContextWrapper(context) {
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
     * - ERROR    — terminal: rootkey load failed, or shutdown timed out
     *              with the node thread still alive.
     */
    enum class State {
        STOPPED, STARTING, STARTED, STOPPING, ERROR
    }

    interface Callback {
        fun onComplete(exitCode: Int)
        fun onError(e: Exception)
    }

    private val serviceScope = CoroutineScope(Dispatchers.Default + SupervisorJob())
    private var nodeJob: Job? = null
    private val dataDir: String = filesDir.absolutePath
    private val nodeProjectDir: File = File(filesDir, NODEJS_PROJECT_DIRNAME)
    private val jsFile: File = File(nodeProjectDir, NODEJS_PROJECT_INDEX_FILENAME)
    private val comapeoSocketFile: File = File(filesDir, ComapeoCoreService.COMAPEO_SOCKET_FILENAME)
    private val controlSocketFile: File = File(filesDir, ComapeoCoreService.CONTROL_SOCKET_FILENAME)
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

    @Volatile
    private var state: State = State.STOPPED

    fun getState(): State = state

    private fun transitionState(to: State) {
        if (state == to) return
        log("NodeJSService state: $state -> $to")
        state = to
        onStateChange?.invoke(to)
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
                NodeJSIPC(
                    controlSocketFile,
                    onMessage = { message -> handleControlMessage(message) },
                ),
            )
        }
    }

    fun start(callback: Callback) {
        if (nodeJob != null) {
            throw IllegalStateException("NodeJS service is already running")
        }
        log("Starting NodeJS service")
        transitionState(State.STARTING)
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
                    )
                )
                log("NodeJS service completed with exit code $exitCode")
                callback.onComplete(exitCode)
            } catch (e: Exception) {
                Log.e(TAG, "Error starting node", e)
                transitionState(State.ERROR)
                callback.onError(e)
            } finally {
                deleteSocketFiles()
                if (state != State.ERROR) transitionState(State.STOPPED)
            }
        }
    }

    /**
     * Routes raw control-socket frames into lifecycle transitions and the
     * rootkey handshake. The frames are well-known JSON shapes
     * (`{"type":"started"}`, `{"type":"ready"}`); a substring match keeps
     * this synchronous so the init-frame send is ordered immediately after
     * `started`.
     */
    private fun handleControlMessage(message: String) {
        log("Control IPC received: $message")
        when {
            message.contains("\"started\"") -> sendInitFrame()
            message.contains("\"ready\"") -> {
                if (state == State.STARTING) transitionState(State.STARTED)
            }
        }
    }

    /**
     * Reads the rootkey via `RootKeyStore`, base64-encodes, and ships the
     * init frame on the control socket. Failures here are terminal: the
     * service transitions to `ERROR` rather than letting Node sit waiting
     * for a frame that will never arrive. The ByteArray is zeroed after
     * encoding — best-effort, since the encoded base64 string still lives
     * in the JVM string pool until GC.
     */
    private fun sendInitFrame() {
        val rootKeyBytes: ByteArray = try {
            RootKeyStore(applicationContext).loadOrInitialize()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to load rootkey", e)
            transitionState(State.ERROR)
            // Best-effort: try to abort the node process. nodeJob will
            // observe the cancellation.
            nodeJob?.cancel()
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
