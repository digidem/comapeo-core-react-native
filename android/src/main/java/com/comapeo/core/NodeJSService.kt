package com.comapeo.core

import android.content.ContextWrapper
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

const val APK_LAST_UPDATE_TIME_KEY = "apk_last_update_time"
const val SHARED_PREFS_NAME_POSTFIX = "_nodejs_preferences"
const val NODEJS_PROJECT_DIRNAME = "nodejs-project"
const val NODEJS_PROJECT_INDEX_FILENAME = "index.mjs"

class NodeJSService(context: android.content.Context) : ContextWrapper(context) {
    interface Callback {
        fun onComplete(exitCode: Int)
        fun onError(e: Exception)
    }

    private val serviceScope = CoroutineScope(Dispatchers.Default + SupervisorJob())
    private var nodeJob: Job? = null
    private val dataDir: String = filesDir.absolutePath
    private val nodeProjectDir: File = File(filesDir, NODEJS_PROJECT_DIRNAME)
    private val jsFile: File = File(nodeProjectDir, NODEJS_PROJECT_INDEX_FILENAME)
    private val socketFile: File = File(filesDir, ComapeoCoreService.SOCKET_FILENAME)
    private val sharedPrefsName = packageName + SHARED_PREFS_NAME_POSTFIX

    companion object {

        init {
            System.loadLibrary("comapeo-core-react-native")
            log(getCurrentABIName())
        }

        @JvmStatic
        external fun getCurrentABIName(): String

        @JvmStatic
        external fun initialize(dataDir: String)

        @JvmStatic
        external fun startNodeWithArguments(args: Array<String>): Int
    }

    init {
        initialize(dataDir)
    }

    fun start(callback: Callback) {
        if (nodeJob != null) {
            throw IllegalStateException("NodeJS service is already running")
        }
        socketFile.delete()
        log("Starting NodeJS service")
        nodeJob = serviceScope.launch {
            try {
                if (shouldCopyAssets()) {
                    withContext(Dispatchers.IO) {
                        nodeProjectDir.deleteRecursively()
                        copyAssetFolder(NODEJS_PROJECT_DIRNAME, nodeProjectDir)
                    }
                }

                val exitCode = startNodeWithArguments(
                    arrayOf(
                        "node",
                        jsFile.absolutePath,
                        socketFile.absolutePath
                    )
                )
                log("NodeJS service completed with exit code $exitCode")
                callback.onComplete(exitCode)
            } catch (e: Exception) {
                Log.e(TAG, "Error starting node", e)
                callback.onError(e)
            } finally {
                stop()
            }
        }
    }

    fun stop() {
        socketFile.delete()
        nodeJob?.cancel()
        serviceScope.cancel()
        log("NodeJS service stopped")
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
            .edit()
            .putLong(APK_LAST_UPDATE_TIME_KEY, currentUpdateTime)
            .apply()
    }

    private fun copyAssetFolder(srcDirname: String, destDir: File) {
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
