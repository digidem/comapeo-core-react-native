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
import org.junit.Ignore
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
        // Stop the service. The service's onDestroy calls Process.killProcess which
        // triggers START_STICKY restart, so we may need to stop multiple times.
        repeat(3) {
            try {
                val intent = Intent(context, ComapeoCoreService::class.java)
                context.stopService(intent)
            } catch (_: Exception) {}
            try {
                startServiceWithAction(Actions.STOP)
            } catch (_: Exception) {}
            if (waitForServiceStopped(3000)) return
        }
        // Last resort: kill the process directly
        device.executeShellCommand(
            "kill \$(pidof $PACKAGE_NAME$SERVICE_PROCESS) 2>/dev/null"
        )
        waitForServiceStopped()
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

    @Ignore("Requires full app bundle — Node.js exits immediately without JS backend")
    @Test
    fun stopActionTriggersGracefulShutdown() {
        startServiceWithAction(Actions.USER_FOREGROUND)
        assertTrue("Service should start", waitForServiceRunning())
        Thread.sleep(3000)

        startServiceWithAction(Actions.STOP)

        assertTrue(
            "Service process should stop within 15s of STOP action",
            waitForServiceStopped()
        )
    }

    @Ignore("Requires full app bundle — Node.js exits immediately without JS backend")
    @Test
    fun notificationStopActionStopsService() {
        startServiceWithAction(Actions.USER_FOREGROUND)
        assertTrue("Service should start", waitForServiceRunning())

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
