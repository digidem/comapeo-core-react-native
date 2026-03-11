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
 * Instrumented tests for [ComapeoCoreService] lifecycle.
 *
 * These tests run in the example app's process (same UID), so they can start
 * the service even though it is not exported. The service itself runs in the
 * :ComapeoCore process.
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
        val intent = Intent(context, ComapeoCoreService::class.java).apply {
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
        @Suppress("DEPRECATION")
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

    // --- Tests ---

    @Test
    fun userForegroundStartsService() {
        startServiceWithAction(Actions.USER_FOREGROUND)

        assertTrue(
            "Service should be running within ${STARTUP_TIMEOUT_MS}ms",
            waitForServiceRunning()
        )
    }

    @Ignore("Requires full app bundle — Node.js exits immediately without JS backend")
    @Test
    fun serviceRunsInSeparateProcess() {
        startServiceWithAction(Actions.USER_FOREGROUND)
        assertTrue("Service should start", waitForServiceRunning())

        assertTrue(
            "Service should run in :ComapeoCore process",
            isServiceProcessRunning()
        )
    }

    @Ignore("Requires full app bundle — Node.js exits immediately without JS backend")
    @Test
    fun stopActionStopsService() {
        startServiceWithAction(Actions.USER_FOREGROUND)
        assertTrue("Service should start", waitForServiceRunning())

        startServiceWithAction(Actions.STOP)

        assertTrue(
            "Service should stop within ${SHUTDOWN_TIMEOUT_MS}ms",
            waitForServiceStopped()
        )
    }

    @Ignore("Requires full app bundle — Node.js exits immediately without JS backend")
    @Test
    fun userBackgroundDoesNotStopService() {
        startServiceWithAction(Actions.USER_FOREGROUND)
        assertTrue("Service should start", waitForServiceRunning())

        // USER_BACKGROUND should NOT stop the service, only update the notification
        startServiceWithAction(Actions.USER_BACKGROUND)
        Thread.sleep(3000)

        assertTrue(
            "Service should still be running after USER_BACKGROUND",
            isServiceRunning()
        )
    }

    @Ignore("Requires full app bundle — Node.js exits immediately without JS backend")
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

    @Ignore("Requires full app bundle — Node.js exits immediately without JS backend")
    @Test
    fun notificationExistsWhileRunning() {
        startServiceWithAction(Actions.USER_FOREGROUND)
        assertTrue("Service should start", waitForServiceRunning())

        Thread.sleep(2000)
        val notifOutput = device.executeShellCommand(
            "dumpsys notification --noredact | grep -A 5 'CoMapeo'"
        )
        assertTrue(
            "Notification with 'CoMapeo' should exist",
            notifOutput.contains("CoMapeo")
        )
    }
}
