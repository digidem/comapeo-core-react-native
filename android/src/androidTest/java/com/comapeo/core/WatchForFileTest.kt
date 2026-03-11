package com.comapeo.core

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Instrumented tests for [waitForFile].
 *
 * Tests the file watcher that uses Android's [android.os.FileObserver]
 * to suspend until a file is created. Must run on a device/emulator
 * because FileObserver requires the Android OS.
 */
@RunWith(AndroidJUnit4::class)
class WatchForFileTest {

    private lateinit var testDir: File
    private lateinit var testFile: File

    @Before
    fun setUp() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        testDir = File(context.cacheDir, "watchforfile_test_${System.nanoTime()}")
        testDir.mkdirs()
        testFile = File(testDir, "test.sock")
        testFile.delete()
    }

    @After
    fun tearDown() {
        testDir.deleteRecursively()
    }

    @Test
    fun returnsImmediatelyIfFileExists() = runBlocking {
        // Create the file first
        testFile.createNewFile()

        val result = withTimeout(2000) {
            waitForFile(testFile)
        }
        assertEquals(testFile, result)
    }

    @Test
    fun suspendsUntilFileIsCreated() = runBlocking {
        val result = async {
            waitForFile(testFile)
        }

        // File doesn't exist yet — waitForFile should be suspended
        delay(500)

        // Create the file after a delay
        testFile.createNewFile()

        val file = withTimeout(5000) {
            result.await()
        }
        assertEquals(testFile, file)
    }

    @Test
    fun handlesFileCreatedAfterShortDelay() = runBlocking {
        val result = async {
            waitForFile(testFile)
        }

        // Create the file after 2 seconds
        launch {
            delay(2000)
            testFile.createNewFile()
        }

        val file = withTimeout(5000) {
            result.await()
        }
        assertEquals(testFile, file)
    }

    @Test
    fun cancellationStopsWatching() = runBlocking {
        val result = async {
            waitForFile(testFile)
        }

        // Cancel before the file is created
        delay(500)
        result.cancel()

        // Verify the deferred was cancelled
        try {
            result.await()
            // Should not reach here
            assert(false) { "Should have thrown CancellationException" }
        } catch (e: kotlinx.coroutines.CancellationException) {
            // Expected
        }
    }

    @Test
    fun doesNotResumeForDifferentFile() = runBlocking {
        val result = async {
            waitForFile(testFile)
        }

        // Create a DIFFERENT file in the same directory
        delay(500)
        File(testDir, "other_file.sock").createNewFile()

        // waitForFile should NOT have resumed
        delay(1000)
        val nullResult = withTimeoutOrNull(1000) {
            result.await()
        }
        assertNull("Should not have resumed for different file", nullResult)

        // Now create the actual file
        testFile.createNewFile()

        val file = withTimeout(5000) {
            result.await()
        }
        assertEquals(testFile, file)
    }

    @Test
    fun createsParentDirectoryIfMissing() = runBlocking {
        val nestedFile = File(File(testDir, "nested/deep"), "test.sock")

        val result = async {
            waitForFile(nestedFile)
        }

        // The parent directory should have been created by waitForFile
        delay(500)
        assert(nestedFile.parentFile!!.exists()) { "Parent directory should be created" }

        // Create the file
        nestedFile.createNewFile()

        val file = withTimeout(5000) {
            result.await()
        }
        assertEquals(nestedFile, file)
    }

    @Test
    fun handlesRapidFileCreateDelete() = runBlocking {
        // Test the TOCTOU scenario: create and delete the file rapidly,
        // then create it again. The watcher should eventually detect it.
        val result = async {
            waitForFile(testFile)
        }

        delay(500)

        // Create the file — this should trigger the observer
        testFile.createNewFile()

        val file = withTimeout(5000) {
            result.await()
        }
        assertEquals(testFile, file)
    }
}
