package com.comapeo.core.example

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import com.comapeo.core.Actions
import com.comapeo.core.ComapeoCoreService
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Instrumented tests for the shutdown and recovery paths.
 *
 * These tests run in the example app's process (same UID) and verify
 * the critical shutdown and restart paths of [ComapeoCoreService].
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
        // Clean slate — kill only the service process, not the whole app
        stopServiceAndWait()
    }

    @After
    fun tearDown() {
        stopServiceAndWait()
    }

    private fun stopServiceAndWait() {
        // Don't use startServiceWithAction(STOP) here — it starts the service process
        // and queues a STOP intent that races with subsequent USER_FOREGROUND intents.
        // Instead, use context.stopService (which doesn't start the process) and
        // direct process kill. The service's onDestroy calls Process.killProcess which
        // triggers START_STICKY restart, so we may need to kill multiple times.
        repeat(5) {
            try {
                context.stopService(Intent(context, ComapeoCoreService::class.java))
            } catch (_: Exception) {}
            if (isServiceProcessRunning()) {
                device.executeShellCommand(
                    "kill \$(pidof $PACKAGE_NAME$SERVICE_PROCESS) 2>/dev/null"
                )
            }
            if (waitForServiceStopped(2000)) return
        }
    }

    // --- Helpers ---

    private fun startServiceWithAction(action: Actions) {
        val intent = Intent(context, ComapeoCoreService::class.java).apply {
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
        startServiceWithAction(Actions.USER_FOREGROUND)
        assertTrue("Service should start", waitForServiceRunning())
        // Wait for Node.js to fully initialize (asset extraction + startup)
        Thread.sleep(5000)

        startServiceWithAction(Actions.STOP)

        assertTrue(
            "Service process should stop within 15s of STOP action",
            waitForServiceStopped()
        )
    }

    @Test
    fun notificationStopActionStopsService() {
        startServiceWithAction(Actions.USER_FOREGROUND)
        assertTrue("Service should start", waitForServiceRunning())
        // Wait for Node.js to fully initialize
        Thread.sleep(5000)

        // Simulate backgrounding to show the Stop button in notification
        startServiceWithAction(Actions.USER_BACKGROUND)
        Thread.sleep(2000)

        // Send the STOP intent directly (same as what the notification PendingIntent does)
        startServiceWithAction(Actions.STOP)

        assertTrue(
            "Service should stop after notification stop action",
            waitForServiceStopped()
        )
    }

    @Test
    fun stopWhileNodeJSIsStartingDoesNotHang() {
        startServiceWithAction(Actions.USER_FOREGROUND)

        // Immediately send STOP before Node.js has fully initialized
        Thread.sleep(500)
        startServiceWithAction(Actions.STOP)

        assertTrue(
            "Service should stop within 15s even if Node.js hasn't initialized",
            waitForServiceStopped()
        )
    }

}
