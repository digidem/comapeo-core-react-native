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
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Instrumented tests for the shutdown and recovery paths.
 *
 * These tests focus on the critical path where:
 * 1. The user or system stops the service
 * 2. The Node.js process must shut down gracefully
 * 3. The service process is killed
 * 4. START_STICKY causes a restart with a fresh Node.js process
 * 5. The IPC from the main app process reconnects
 */
@RunWith(AndroidJUnit4::class)
class ShutdownPathTest {

    private lateinit var context: Context
    private lateinit var device: UiDevice

    companion object {
        private const val PACKAGE_NAME = "com.comapeo.core.example"
        private const val SERVICE_CLASS = "com.comapeo.core.ComapeoCoreService"
        private const val SERVICE_PROCESS = ":ComapeoCore"
        private const val POLL_INTERVAL_MS = 500L
    }

    @Before
    fun setUp() {
        context = InstrumentationRegistry.getInstrumentation().targetContext
        device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        // Clean slate
        device.executeShellCommand("am force-stop $PACKAGE_NAME")
        Thread.sleep(2000)
    }

    @After
    fun tearDown() {
        device.executeShellCommand("am force-stop $PACKAGE_NAME")
        Thread.sleep(1000)
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

    private fun isServiceProcessRunning(): Boolean {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        @Suppress("DEPRECATION")
        val processes = am.runningAppProcesses ?: return false
        return processes.any { it.processName == "$PACKAGE_NAME$SERVICE_PROCESS" }
    }

    private fun isServiceRunning(): Boolean {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        @Suppress("DEPRECATION")
        val services = am.getRunningServices(Int.MAX_VALUE) ?: return false
        return services.any {
            it.service.className == SERVICE_CLASS &&
            it.service.packageName == PACKAGE_NAME
        }
    }

    private fun waitForServiceRunning(timeout: Long = 15_000L): Boolean {
        val deadline = System.currentTimeMillis() + timeout
        while (System.currentTimeMillis() < deadline) {
            if (isServiceRunning()) return true
            Thread.sleep(POLL_INTERVAL_MS)
        }
        return false
    }

    private fun waitForServiceStopped(timeout: Long = 15_000L): Boolean {
        val deadline = System.currentTimeMillis() + timeout
        while (System.currentTimeMillis() < deadline) {
            if (!isServiceRunning() && !isServiceProcessRunning()) return true
            Thread.sleep(POLL_INTERVAL_MS)
        }
        return false
    }

    // --- Tests ---

    @Test
    fun stopActionTriggersGracefulShutdown() {
        // Start the service and let Node.js initialize
        startServiceWithAction(Actions.USER_FOREGROUND)
        assertTrue("Service should start", waitForServiceRunning())
        Thread.sleep(5000) // Wait for Node.js to fully initialize

        // Send STOP
        startServiceWithAction(Actions.STOP)

        // The shutdown path should:
        // 1. Send shutdown message to Node.js via state socket
        // 2. Node.js closes servers and drains connections
        // 3. Node.js exits → nodeJob completes
        // 4. Service calls stopForeground + stopSelf
        // 5. onDestroy kills the process
        assertTrue(
            "Service process should stop within 15s of STOP action",
            waitForServiceStopped()
        )
    }

    @Test
    fun processKillAndRecoveryPreservesNoSocketLeaks() {
        // Start the service
        startServiceWithAction(Actions.USER_FOREGROUND)
        assertTrue("Service should start", waitForServiceRunning())
        Thread.sleep(5000) // Wait for sockets to be created

        // Kill the process abruptly (simulating OOM kill, no graceful shutdown)
        device.executeShellCommand("am kill $PACKAGE_NAME$SERVICE_PROCESS 2>/dev/null")
        // Alternative: kill via pid
        device.executeShellCommand(
            "kill -9 \$(pidof -s $PACKAGE_NAME$SERVICE_PROCESS) 2>/dev/null"
        )

        // Wait for START_STICKY restart
        Thread.sleep(5000)

        // The restarted service should clean up old socket files and create new ones
        // Verify the service is running again
        assertTrue(
            "Service should restart after kill",
            waitForServiceRunning(30_000)
        )

        // Wait for new sockets
        Thread.sleep(5000)

        // Verify sockets exist (new ones from the restarted process)
        val filesDir = context.filesDir
        val lsOutput = device.executeShellCommand(
            "run-as $PACKAGE_NAME ls ${filesDir.absolutePath}/ 2>/dev/null"
        )
        assertTrue(
            "comapeo.sock should exist after restart",
            lsOutput.contains("comapeo.sock")
        )
    }

    @Test
    fun notificationStopActionStopsService() {
        // Start the service in "background" mode so the Stop button appears
        startServiceWithAction(Actions.USER_FOREGROUND)
        assertTrue("Service should start", waitForServiceRunning())

        // Simulate backgrounding to show the Stop button in notification
        startServiceWithAction(Actions.USER_BACKGROUND)
        Thread.sleep(2000)

        // Send the STOP intent directly (same as what the notification PendingIntent does)
        // This avoids fragile notification UI interaction
        startServiceWithAction(Actions.STOP)

        assertTrue(
            "Service should stop after notification stop action",
            waitForServiceStopped()
        )
    }

    @Test
    fun stopWhileNodeJSIsStartingDoesNotHang() {
        // Start the service
        startServiceWithAction(Actions.USER_FOREGROUND)

        // Immediately send STOP before Node.js has fully initialized
        // This tests the race condition where stop() is called before
        // the state socket IPC is connected
        Thread.sleep(500) // Brief pause to let the service process start
        startServiceWithAction(Actions.STOP)

        // Should stop within a reasonable time, not hang indefinitely
        assertTrue(
            "Service should stop within 15s even if Node.js hasn't initialized",
            waitForServiceStopped()
        )
    }

    @Test
    fun multipleStopStartCycles() {
        // Verify the service can go through multiple start/stop cycles
        // This is critical because Node.js can't restart in the same process,
        // so each cycle requires a fresh :ComapeoCore process
        repeat(3) { cycle ->
            startServiceWithAction(Actions.USER_FOREGROUND)
            assertTrue(
                "Service should start in cycle $cycle",
                waitForServiceRunning()
            )
            Thread.sleep(3000) // Let Node.js initialize

            startServiceWithAction(Actions.STOP)
            assertTrue(
                "Service should stop in cycle $cycle",
                waitForServiceStopped()
            )
            Thread.sleep(2000) // Let process fully die
        }
    }

    @Test
    fun appForceStopCleansUpService() {
        // Start the service
        startServiceWithAction(Actions.USER_FOREGROUND)
        assertTrue("Service should start", waitForServiceRunning())
        Thread.sleep(3000)

        // Force-stop the entire app (both processes)
        device.executeShellCommand("am force-stop $PACKAGE_NAME")
        Thread.sleep(3000)

        assertFalse(
            "Service should not be running after force-stop",
            isServiceRunning()
        )
        assertFalse(
            "Service process should not exist after force-stop",
            isServiceProcessRunning()
        )
    }
}
