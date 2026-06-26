package com.comapeo.core.integration

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
        private const val PACKAGE_NAME = "com.comapeo.core.integration"
        private const val SERVICE_CLASS = "com.comapeo.core.ComapeoCoreService"
        private const val SERVICE_PROCESS = ":ComapeoCore"
        private const val STARTUP_TIMEOUT_MS = 15_000L
        private const val SHUTDOWN_TIMEOUT_MS = 10_000L
        // SELF_TERMINATE_GRACE_MS (3s) + node teardown + Sentry flush (2s) + margin.
        private const val SELF_TERMINATE_TIMEOUT_MS = 12_000L
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

    private fun getServiceProcessPid(): Int? {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        @Suppress("DEPRECATION")
        val processes = am.runningAppProcesses ?: return null
        return processes.firstOrNull {
            it.processName == "$PACKAGE_NAME$SERVICE_PROCESS"
        }?.pid
    }

    /**
     * Waits for the Android service and its `:ComapeoCore` child process, then
     * holds for [stabilityDuration] verifying the PID does not change. If the
     * PID changes or the process disappears, Node.js has crashed at startup —
     * throws [AssertionError] immediately with a pointer to logcat.
     *
     * Returns false only if the service never appears within [timeout].
     */
    private fun waitForServiceRunning(
        timeout: Long = STARTUP_TIMEOUT_MS,
        stabilityDuration: Long = 1_500L,
    ): Boolean {
        val deadline = System.currentTimeMillis() + timeout
        var initialPid: Int = -1
        while (System.currentTimeMillis() < deadline && initialPid == -1) {
            if (isServiceRunning()) {
                initialPid = getServiceProcessPid() ?: -1
            }
            if (initialPid == -1) Thread.sleep(POLL_INTERVAL_MS)
        }
        if (initialPid == -1) return false

        val stabilityDeadline = System.currentTimeMillis() + stabilityDuration
        while (System.currentTimeMillis() < stabilityDeadline) {
            Thread.sleep(POLL_INTERVAL_MS)
            val currentPid = getServiceProcessPid()
            if (currentPid == null) {
                throw AssertionError(
                    ":ComapeoCore process (pid $initialPid) died. " +
                    "Check logcat for 'E nodejs' — Node.js likely crashed at startup."
                )
            }
            if (currentPid != initialPid) {
                throw AssertionError(
                    ":ComapeoCore process crashed and restarted (pid $initialPid -> $currentPid). " +
                    "Check logcat for 'E nodejs' — Node.js likely crashed at startup."
                )
            }
        }
        return true
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

        assertTrue(
            "Service should run in :ComapeoCore process",
            isServiceProcessRunning()
        )
    }

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

    @Test
    fun userBackgroundDoesNotStopService() {
        startServiceWithAction(Actions.USER_FOREGROUND)
        assertTrue("Service should start", waitForServiceRunning())
        // Wait for Node.js to fully initialize (asset extraction + startup)
        Thread.sleep(5000)

        // USER_BACKGROUND should NOT stop the service, only update the notification
        startServiceWithAction(Actions.USER_BACKGROUND)
        Thread.sleep(3000)

        assertTrue(
            "Service should still be running after USER_BACKGROUND",
            isServiceRunning()
        )
    }

    @Test
    fun doubleStartIsIdempotent() {
        startServiceWithAction(Actions.USER_FOREGROUND)
        assertTrue("Service should start", waitForServiceRunning())
        // Wait for Node.js to fully initialize
        Thread.sleep(5000)

        // Send USER_FOREGROUND again — should be a no-op
        startServiceWithAction(Actions.USER_FOREGROUND)
        Thread.sleep(2000)

        assertTrue(
            "Service should still be running after double start",
            isServiceRunning()
        )
    }

    /**
     * Verifies fix: isServiceStarted was not reset on stop, preventing restart.
     * Without the fix, the second USER_FOREGROUND would be a no-op because
     * isServiceStarted was still true after stop.
     */
    @Test
    fun stopThenRestartWorks() {
        // First start
        startServiceWithAction(Actions.USER_FOREGROUND)
        assertTrue("Service should start", waitForServiceRunning())
        Thread.sleep(5000)

        // Stop and wait for the process to fully die
        stopServiceAndWait()

        // Restart — this would fail if isServiceStarted wasn't reset
        startServiceWithAction(Actions.USER_FOREGROUND)
        assertTrue(
            "Service should restart after being stopped",
            waitForServiceRunning()
        )
    }

    /**
     * Verifies the FGS self-terminate watchdog: a terminal ERROR with the node
     * thread still alive (driven by the debug-only SIMULATE_FATAL_ERROR seam, which
     * mimics a dropped `error-native` on a startup-watchdog/rootkey failure) must
     * make the `:ComapeoCore` process die on its own, and a subsequent
     * USER_FOREGROUND must cold-start a fresh process. Without the watchdog the
     * process would stay alive in ERROR and `waitForServiceStopped` would time out.
     */
    @Test
    fun selfTerminatesAfterForcedErrorThenRecovers() {
        startServiceWithAction(Actions.USER_FOREGROUND)
        assertTrue("Service should start", waitForServiceRunning())
        // Let Node.js finish booting so the error is forced from a live runtime.
        Thread.sleep(5000)
        val initialPid = getServiceProcessPid()
        assertTrue("Service process should be running before the forced error", initialPid != null)

        // Force a terminal ERROR with node left alive; the watchdog should kill the
        // process within SELF_TERMINATE_GRACE_MS (3s) + teardown.
        startServiceWithAction(Actions.SIMULATE_FATAL_ERROR)
        assertTrue(
            "Service should self-terminate within ${SELF_TERMINATE_TIMEOUT_MS}ms after a forced error",
            waitForServiceStopped(SELF_TERMINATE_TIMEOUT_MS)
        )

        // Recovery: a fresh foreground cold-starts a new process.
        startServiceWithAction(Actions.USER_FOREGROUND)
        assertTrue(
            "Service should recover (cold-start) after self-termination",
            waitForServiceRunning()
        )
    }

    @Test
    fun notificationExistsWhileRunning() {
        startServiceWithAction(Actions.USER_FOREGROUND)
        assertTrue("Service should start", waitForServiceRunning())
        // Wait for Node.js to fully initialize
        Thread.sleep(5000)
        val notifOutput = device.executeShellCommand(
            "dumpsys notification --noredact | grep -A 5 'CoMapeo'"
        )
        assertTrue(
            "Notification with 'CoMapeo' should exist",
            notifOutput.contains("CoMapeo")
        )
    }
}
