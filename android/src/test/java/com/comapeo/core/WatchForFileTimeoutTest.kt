package com.comapeo.core

import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import kotlin.coroutines.resume

/**
 * JVM unit tests for the timeout pattern used in [waitForFile].
 *
 * The actual waitForFile function uses Android's FileObserver and can't run
 * on JVM. These tests verify the coroutine timeout wrapper pattern:
 * - withTimeout throws TimeoutCancellationException when file never appears
 * - suspendCancellableCoroutine resumes immediately when condition is met
 * - Cancellation propagates correctly
 */
class WatchForFileTimeoutTest {

    @Test(expected = TimeoutCancellationException::class)
    fun timeoutThrowsWhenFileNeverAppears() = runTest {
        // Simulates waitForFile when the file is never created
        withTimeout(100) {
            suspendCancellableCoroutine<Unit> { /* never resumed */ }
        }
    }

    @Test
    fun immediateResumeWhenAlreadyExists() = runTest {
        // Simulates the "check after observer start" path where file already exists
        val result = withTimeout(1000) {
            suspendCancellableCoroutine { continuation ->
                // Simulates: observer.startWatching() then file.exists() == true
                val fileAlreadyExists = true
                if (fileAlreadyExists) {
                    continuation.resume("found")
                }
            }
        }
        assertEquals("found", result)
    }

    @Test
    fun cancellationCallbackInvoked() = runTest {
        var cleanupCalled = false

        try {
            withTimeout(100) {
                suspendCancellableCoroutine<Unit> { continuation ->
                    continuation.invokeOnCancellation {
                        // Simulates: observer.stopWatching()
                        cleanupCalled = true
                    }
                    // Never resume — simulates file never appearing
                }
            }
        } catch (_: TimeoutCancellationException) {
            // Expected
        }

        assertTrue("Cleanup (observer.stopWatching) should be called on timeout", cleanupCalled)
    }

    @Test
    fun doubleResumeIsIgnored() = runTest {
        // Simulates the race where both observer and exists-check try to resume
        // The fix uses continuation.isCompleted to guard against double resume
        val result = withTimeout(1000) {
            suspendCancellableCoroutine { continuation ->
                // First resume (from observer callback)
                if (!continuation.isCompleted) {
                    continuation.resume("from-observer")
                }
                // Second resume (from exists check) — should be safely skipped
                if (!continuation.isCompleted) {
                    fail("Should not reach second resume after first completed")
                }
            }
        }
        assertEquals("from-observer", result)
    }
}
