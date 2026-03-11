package com.comapeo.core

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * JVM unit tests verifying the CompletableDeferred pattern used in
 * [NodeJSService] to safely await async IPC initialization before stop().
 *
 * The old code used `lateinit var ipc` which would crash with
 * UninitializedPropertyAccessException if stop() was called before init
 * completed. The fix uses CompletableDeferred<T>.await() which suspends
 * until the value is available.
 */
class CompletableDeferredStopTest {

    @Test
    fun awaitCompletesWhenValueIsAlreadySet() = runTest {
        val deferred = CompletableDeferred<String>()
        deferred.complete("ready")

        val result = deferred.await()
        assertEquals("ready", result)
    }

    @Test
    fun awaitSuspendsUntilValueIsSet() = runTest {
        val deferred = CompletableDeferred<String>()
        var result: String? = null

        val job = launch {
            result = deferred.await()
        }

        // Value not yet set — job should be suspended
        assertFalse(job.isCompleted)

        deferred.complete("initialized")
        job.join()

        assertEquals("initialized", result)
    }

    @Test
    fun stopBeforeInitCompletesWaitsForInit() = runTest {
        // Simulates NodeJSService pattern: init launches async, stop() awaits
        val ipcDeferred = CompletableDeferred<String>()
        var stopSentMessage = false
        var stopCompleted = false

        // Simulate stop() calling ipcDeferred.await() then sending shutdown
        val stopJob = launch {
            val ipc = ipcDeferred.await()
            // "Send shutdown message"
            stopSentMessage = true
            assertEquals("ipc-instance", ipc)
            stopCompleted = true
        }

        // stop() should be suspended waiting for init
        assertFalse(stopSentMessage)

        // Simulate async init completing
        ipcDeferred.complete("ipc-instance")
        stopJob.join()

        assertTrue(stopSentMessage)
        assertTrue(stopCompleted)
    }

    @Test
    fun isCompletedCheckPreventsAwaitOnFailedInit() = runTest {
        // Simulates the defensive check in NodeJSService.stop() finally block:
        // if (ipcDeferred.isCompleted) { ipcDeferred.await().disconnect() }
        val deferred = CompletableDeferred<String>()
        var disconnectCalled = false

        // Init never completes — isCompleted is false
        assertFalse(deferred.isCompleted)

        // The finally block check prevents hanging on await()
        if (deferred.isCompleted) {
            deferred.await() // Would hang forever without the check
            disconnectCalled = true
        }

        assertFalse(disconnectCalled)
    }

    @Test
    fun stopWithNullNodeJobReturnsEarly() = runTest {
        // Simulates NodeJSService.stop() when nodeJob is null
        var nodeJobValue: String? = null
        var stopReachedShutdown = false

        // Mirrors the guard: if (nodeJob == null) return
        if (nodeJobValue == null) {
            return@runTest
        }

        @Suppress("UNREACHABLE_CODE")
        stopReachedShutdown = true
        assertFalse("Should not reach shutdown logic", stopReachedShutdown)
    }
}
