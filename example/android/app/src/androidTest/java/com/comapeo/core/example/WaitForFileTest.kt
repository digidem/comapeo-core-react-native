package com.comapeo.core.example

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.comapeo.core.waitForFile
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Instrumented tests for [waitForFile].
 *
 * These tests verify:
 * - Timeout when file never appears (fix: added withTimeout wrapper)
 * - Immediate return when file already exists
 * - Observer detects file creation (TOCTOU fix: observer starts before exists check)
 */
@RunWith(AndroidJUnit4::class)
class WaitForFileTest {

    private lateinit var testDir: File

    @Before
    fun setUp() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        testDir = File(context.cacheDir, "waitForFile-test-${System.currentTimeMillis()}")
        testDir.mkdirs()
    }

    @After
    fun tearDown() {
        testDir.deleteRecursively()
    }

    @Test(expected = TimeoutCancellationException::class)
    fun timeoutWhenFileNeverAppears() = runTest {
        val file = File(testDir, "never-created.txt")
        waitForFile(file, timeoutMs = 500)
    }

    @Test
    fun returnsImmediatelyWhenFileAlreadyExists() = runTest {
        val file = File(testDir, "already-exists.txt")
        file.createNewFile()

        val result = waitForFile(file, timeoutMs = 2000)
        assertEquals(file, result)
    }

    @Test
    fun detectsFileCreatedAfterWatchStarts() = runTest {
        val file = File(testDir, "created-later.txt")

        // Launch waitForFile in background
        val job = launch {
            val result = waitForFile(file, timeoutMs = 5000)
            assertEquals(file, result)
        }

        // Wait a bit then create the file
        kotlinx.coroutines.delay(500)
        file.createNewFile()

        job.join()
        assertTrue("Job should complete successfully", job.isCompleted)
    }

    @Test
    fun createsParentDirectoryIfMissing() = runTest {
        val nestedDir = File(testDir, "nested/deep")
        val file = File(nestedDir, "target.txt")

        // Parent doesn't exist yet
        assertTrue(!nestedDir.exists())

        val job = launch {
            waitForFile(file, timeoutMs = 3000)
        }

        // waitForFile should create the parent dir — give it a moment
        kotlinx.coroutines.delay(200)
        assertTrue("Parent directory should be created", nestedDir.exists())

        // Create the file so the coroutine completes
        file.createNewFile()
        job.join()
    }

    @Test
    fun throwsForFileWithNoParent() = runTest {
        // A root-level File object on Android won't have a null parent in practice,
        // but we can test the error path by using a File with explicit empty parent
        try {
            // File("/") has parentFile == null on some systems
            val rootFile = File("/")
            if (rootFile.parentFile == null) {
                waitForFile(rootFile, timeoutMs = 500)
                fail("Should throw IllegalArgumentException for file with no parent")
            }
        } catch (_: IllegalArgumentException) {
            // Expected
        }
    }
}
