package com.comapeo.core

import android.os.FileObserver
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeout
import java.io.File

/**
 * A suspendable function that watches for file creation at the specified path.
 * The function will suspend until the specified file is created or timeout occurs.
 *
 * @param file The file to watch for creation
 * @param timeoutMs Maximum time to wait for the file to appear (default: 30 seconds)
 * @return The created File object
 * @throws IllegalArgumentException if the file has no parent directory
 * @throws kotlinx.coroutines.TimeoutCancellationException if the file is not created within the timeout
 */
suspend fun waitForFile(file: File, timeoutMs: Long = 30_000L): File = withTimeout(timeoutMs) {
    suspendCancellableCoroutine { continuation ->

        // Get parent directory and throw if null
        val parentDir = file.parentFile ?: throw IllegalArgumentException("File must have a parent directory")

        // Create the directory if it doesn't exist
        if (!parentDir.exists()) {
            parentDir.mkdirs()
        }

        // Create file observer BEFORE checking existence to avoid TOCTOU race.
        val observer = object : FileObserver(parentDir, CREATE) {
            override fun onEvent(event: Int, path: String?) {
                if (path == file.name) {
                    stopWatching()
                    if (!continuation.isCompleted) {
                        continuation.resumeWith(Result.success(file))
                    }
                }
            }
        }

        observer.startWatching()

        // Check AFTER starting the observer — if the file was created between
        // observer setup and this check, the observer will have caught it.
        // If it existed before, we catch it here.
        if (file.exists()) {
            observer.stopWatching()
            if (!continuation.isCompleted) {
                continuation.resumeWith(Result.success(file))
            }
        }

        continuation.invokeOnCancellation {
            observer.stopWatching()
        }
    }
}
