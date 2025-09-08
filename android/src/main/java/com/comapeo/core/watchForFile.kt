package com.comapeo.core

import android.os.FileObserver
import kotlinx.coroutines.suspendCancellableCoroutine
import java.io.File

/**
 * A suspendable function that watches for file creation at the specified path.
 * The function will suspend until the specified file is created or timeout occurs.
 *
 * @param file The file to watch for creation
 * @return The created File object
 * @throws IllegalArgumentException if the file has no parent directory
 */
suspend fun waitForFile(file: File): File = suspendCancellableCoroutine { continuation ->

    // Check if the file already exists
    if (file.exists()) {
        continuation.resumeWith(Result.success(file))
        return@suspendCancellableCoroutine
    }

    // Get parent directory and throw if null
    val parentDir = file.parentFile ?: throw IllegalArgumentException("File must have a parent directory")

    // Create the directory if it doesn't exist
    if (!parentDir.exists()) {
        parentDir.mkdirs()
    }

    // Create file observer
    val observer = object : FileObserver(parentDir, CREATE) {
        override fun onEvent(event: Int, path: String?) {
            if (path == file.name) {
                // Stop observing
                stopWatching()

                // Resume the coroutine with the file
                if (!continuation.isCompleted) {
                    continuation.resumeWith(Result.success(file))
                }
            }
        }
    }

    observer.startWatching()

    continuation.invokeOnCancellation {
        observer.stopWatching()
    }
}
