package com.comapeo.core

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Instrumented tests for [ComapeoCoreService] lifecycle.
 *
 * These tests verify the foreground service starts, stops, and restarts
 * correctly in response to intents and system events. They run on a real
 * device/emulator and interact with the actual Android service infrastructure.
 */
@RunWith(AndroidJUnit4::class)
class ServiceLifecycleTest {

    private lateinit var context: Context
    private lateinit var device: UiDevice

    companion object {
        private const val PACKAGE_NAME = "com.comapeo.core.example"
        private const val SERVICE_CLASS = "com.comapeo.core.ComapeoCoreService"
        private const val SERVICE_PROCESS = ":ComapeoCore"
        private const val STARTUP_TIMEOUT_MS = 15_000L
        private const val SHUTDOWN_TIMEOUT_MS = 10_000L
        private const val POLL_INTERVAL_MS = 500L
    }

    @Before
    fun setUp() {
        context = InstrumentationRegistry.getInstrumentation().targetContext
        device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        // Ensure service is stopped before each test
        stopServiceAndWait()
    }

    @After
    fun tearDown() {
        stopServiceAndWait()
    }

    // --- Helpers ---

    private fun startServiceWithAction(action: Actions) {
        val intent = Intent().apply {
            setClassName(PACKAGE_NAME, SERVICE_CLASS)
            this.action = action.name
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent)
        } else {
            context.startService(intent)
        }
    }

    /**
     * Check if the service process is running by looking for the :ComapeoCore process.
     */
    private fun isServiceProcessRunning(): Boolean {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        @Suppress("DEPRECATION") // getRunningAppProcesses is the only way
        val processes = am.runningAppProcesses ?: return false
        return processes.any { it.processName == "$PACKAGE_NAME$SERVICE_PROCESS" }
    }

    /**
     * Check if the service is in the running services list.
     */
    private fun isServiceRunning(): Boolean {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        @Suppress("DEPRECATION")
        val services = am.getRunningServices(Int.MAX_VALUE) ?: return false
        return services.any {
            it.service.className == SERVICE_CLASS &&
            it.service.packageName == PACKAGE_NAME
        }
    }

    private fun waitForServiceRunning(timeout: Long = STARTUP_TIMEOUT_MS): Boolean {
        val deadline = System.currentTimeMillis() + timeout
        while (System.currentTimeMillis() < deadline) {
            if (isServiceRunning()) return true
            Thread.sleep(POLL_INTERVAL_MS)
        }
        return false
    }

    private fun waitForServiceStopped(timeout: Long = SHUTDOWN_TIMEOUT_MS): Boolean {
        val deadline = System.currentTimeMillis() + timeout
        while (System.currentTimeMillis() < deadline) {
            if (!isServiceRunning() && !isServiceProcessRunning()) return true
            Thread.sleep(POLL_INTERVAL_MS)
        }
        return false
    }

    private fun stopServiceAndWait() {
        try {
            startServiceWithAction(Actions.STOP)
        } catch (e: Exception) {
            // Service may not be running
        }
        // Also force-stop via adb to be sure
        device.executeShellCommand("am force-stop $PACKAGE_NAME")
        Thread.sleep(2000) // Let process cleanup happen
    }

    // --- Tests ---

    @Test
    fun userForegroundStartsService() {
        startServiceWithAction(Actions.USER_FOREGROUND)

        assertTrue(
            "Service should be running within ${STARTUP_TIMEOUT_MS}ms",
            waitForServiceRunning()
        )
    }

    @Test
    fun serviceRunsInSeparateProcess() {
        startServiceWithAction(Actions.USER_FOREGROUND)
        assertTrue("Service should start", waitForServiceRunning())

        // Verify the :ComapeoCore process exists
        assertTrue(
            "Service should run in :ComapeoCore process",
            isServiceProcessRunning()
        )
    }

    @Test
    fun stopActionStopsService() {
        // Start first
        startServiceWithAction(Actions.USER_FOREGROUND)
        assertTrue("Service should start", waitForServiceRunning())

        // Then stop
        startServiceWithAction(Actions.STOP)

        assertTrue(
            "Service should stop within ${SHUTDOWN_TIMEOUT_MS}ms",
            waitForServiceStopped()
        )
    }

    @Test
    fun userBackgroundDoesNotStopService() {
        // Start the service
        startServiceWithAction(Actions.USER_FOREGROUND)
        assertTrue("Service should start", waitForServiceRunning())

        // Send USER_BACKGROUND — should NOT stop the service
        startServiceWithAction(Actions.USER_BACKGROUND)
        Thread.sleep(3000) // Wait to be sure

        assertTrue(
            "Service should still be running after USER_BACKGROUND",
            isServiceRunning()
        )
    }

    @Test
    fun serviceRestartsAfterProcessKill() {
        // Start the service
        startServiceWithAction(Actions.USER_FOREGROUND)
        assertTrue("Service should start", waitForServiceRunning())

        // Kill the :ComapeoCore process (simulates Android OOM kill)
        val killOutput = device.executeShellCommand(
            "run-as $PACKAGE_NAME kill \$(pidof -s $PACKAGE_NAME$SERVICE_PROCESS)"
        )

        // START_STICKY should cause the system to restart the service
        // This may take a few seconds
        assertTrue(
            "Service should restart after process kill (START_STICKY)",
            waitForServiceRunning(30_000)
        )
    }

    @Test
    fun socketFilesCreatedOnStart() {
        startServiceWithAction(Actions.USER_FOREGROUND)
        assertTrue("Service should start", waitForServiceRunning())

        // Wait for Node.js to create socket files
        Thread.sleep(5000)

        val filesDir = context.filesDir
        val comapeoSocket = java.io.File(filesDir, "comapeo.sock")
        val stateSocket = java.io.File(filesDir, "state.sock")

        // Note: socket files are in the :ComapeoCore process's files dir.
        // From the test process, we can check via adb
        val lsOutput = device.executeShellCommand(
            "run-as $PACKAGE_NAME ls -la ${filesDir.absolutePath}/"
        )
        assertTrue(
            "comapeo.sock should exist after service starts",
            lsOutput.contains("comapeo.sock")
        )
        assertTrue(
            "state.sock should exist after service starts",
            lsOutput.contains("state.sock")
        )
    }

    @Test
    fun socketFilesCleanedUpOnStop() {
        // Start and wait for sockets to be created
        startServiceWithAction(Actions.USER_FOREGROUND)
        assertTrue("Service should start", waitForServiceRunning())
        Thread.sleep(5000) // Wait for Node.js to create sockets

        // Stop the service
        startServiceWithAction(Actions.STOP)
        assertTrue("Service should stop", waitForServiceStopped())

        // Verify socket files are cleaned up
        val filesDir = context.filesDir
        val lsOutput = device.executeShellCommand(
            "run-as $PACKAGE_NAME ls ${filesDir.absolutePath}/ 2>/dev/null"
        )
        assertFalse(
            "comapeo.sock should be deleted after service stops",
            lsOutput.contains("comapeo.sock")
        )
        assertFalse(
            "state.sock should be deleted after service stops",
            lsOutput.contains("state.sock")
        )
    }

    @Test
    fun doubleStartIsIdempotent() {
        startServiceWithAction(Actions.USER_FOREGROUND)
        assertTrue("Service should start", waitForServiceRunning())

        // Send USER_FOREGROUND again — should be a no-op
        startServiceWithAction(Actions.USER_FOREGROUND)
        Thread.sleep(2000)

        assertTrue(
            "Service should still be running after double start",
            isServiceRunning()
        )
    }

    @Test
    fun notificationExistsWhileRunning() {
        startServiceWithAction(Actions.USER_FOREGROUND)
        assertTrue("Service should start", waitForServiceRunning())

        // Check notification via dumpsys
        Thread.sleep(2000) // Let notification appear
        val notifOutput = device.executeShellCommand(
            "dumpsys notification --noredact | grep -A 5 'CoMapeo'"
        )
        assertTrue(
            "Notification with 'CoMapeo' should exist",
            notifOutput.contains("CoMapeo")
        )
    }
}
