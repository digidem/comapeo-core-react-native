package com.comapeo.core

import android.os.Build
import androidx.annotation.RequiresApi
import java.io.File
import java.nio.file.*
import kotlinx.coroutines.*

sealed class FileWatchResult {
    data object FileExists : FileWatchResult()
    data object FileCreated : FileWatchResult()
    data class Error(val exception: Exception) : FileWatchResult()
    data object Cancelled : FileWatchResult()
}

suspend fun watchForFile(file: File, pollIntervalMs: Long = 500): FileWatchResult {
    if (file.exists()) {
        return FileWatchResult.FileExists
    }

    return withContext(Dispatchers.IO) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                watchWithWatchService(file)
            } else {
                watchWithPolling(file, pollIntervalMs)
            }
        } catch (e: CancellationException) {
            FileWatchResult.Cancelled
        } catch (e: Exception) {
            FileWatchResult.Error(e)
        }
    }
}

@RequiresApi(Build.VERSION_CODES.O)
private suspend fun watchWithWatchService(file: File): FileWatchResult = coroutineScope {
    val path = Paths.get(file.parent)
    val fileName = file.name

    FileSystems.getDefault().newWatchService().use { watchService ->
        path.register(watchService, StandardWatchEventKinds.ENTRY_CREATE)

        while (isActive) {
            val key = watchService.take()
            key.pollEvents().forEach { event ->
                val eventPath = event.context() as Path
                if (event.kind() == StandardWatchEventKinds.ENTRY_CREATE &&
                    eventPath.toString() == fileName) {
                    return@coroutineScope FileWatchResult.FileCreated
                }
            }
            key.reset()
        }
        return@coroutineScope FileWatchResult.Cancelled
    }
}

private suspend fun watchWithPolling(file: File, pollIntervalMs: Long): FileWatchResult = coroutineScope {
    while (isActive) {
        if (file.exists()) {
            return@coroutineScope FileWatchResult.FileCreated
        }
        delay(pollIntervalMs)
    }
    return@coroutineScope FileWatchResult.Cancelled
}
