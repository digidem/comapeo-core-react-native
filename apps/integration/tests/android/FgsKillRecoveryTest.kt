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
import com.comapeo.core.NodeJSIPC
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * In-place FGS-kill recovery: with the app process staying up (as after a
 * low-memory kill of only the `:ComapeoCore` process), kill the service
 * process and assert that the system restarts it and that reconnect-enabled
 * [NodeJSIPC] clients recover on their own — no `connect()`/`sendMessage()`
 * nudge: the control socket reconnects and replays `started`/`ready` (the
 * frames `ComapeoCoreModule` derives STARTED from), and a message-socket
 * round-trip succeeds on the same client instance after the restart.
 */
@RunWith(AndroidJUnit4::class)
class FgsKillRecoveryTest {

    private lateinit var context: Context
    private lateinit var device: UiDevice
    private var controlIpc: NodeJSIPC? = null
    private var messageIpc: NodeJSIPC? = null

    companion object {
        private const val PACKAGE_NAME = "com.comapeo.core.integration"
        private const val SERVICE_CLASS = "com.comapeo.core.ComapeoCoreService"
        private const val SERVICE_PROCESS = ":ComapeoCore"
        private const val STARTUP_TIMEOUT_MS = 15_000L
        // First boot after install extracts the backend assets; debug builds
        // boot Node slowly, so give the ready frame a generous window. Stays
        // below NodeJSIPC's 120s reconnect window, so the client cannot give
        // up into State.Error before this assertion deadline expires.
        private const val READY_TIMEOUT_S = 90L
        private const val RPC_TIMEOUT_MS = 20_000L
        private const val POLL_INTERVAL_MS = 500L
        private const val MANAGER_CHANNEL_ID = "@@comapeo/manager"
    }

    @Before
    fun setUp() {
        context = InstrumentationRegistry.getInstrumentation().targetContext
        device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        stopServiceAndWait()
    }

    @After
    fun tearDown() {
        controlIpc?.close()
        messageIpc?.close()
        controlIpc = null
        messageIpc = null
        stopServiceAndWait()
    }

    // --- Helpers (same harness patterns as ServiceLifecycleTest) ---

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

    private fun isServiceRunning(): Boolean {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        @Suppress("DEPRECATION")
        val services = am.getRunningServices(Int.MAX_VALUE) ?: return false
        return services.any {
            it.service.className == SERVICE_CLASS &&
            it.service.packageName == PACKAGE_NAME
        }
    }

    private fun isServiceProcessRunning(): Boolean = getServiceProcessPid() != null

    private fun getServiceProcessPid(): Int? {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        @Suppress("DEPRECATION")
        val processes = am.runningAppProcesses ?: return null
        return processes.firstOrNull {
            it.processName == "$PACKAGE_NAME$SERVICE_PROCESS"
        }?.pid
    }

    private fun waitForServiceRunning(timeout: Long = STARTUP_TIMEOUT_MS): Boolean {
        val deadline = System.currentTimeMillis() + timeout
        while (System.currentTimeMillis() < deadline) {
            if (isServiceRunning() && getServiceProcessPid() != null) return true
            Thread.sleep(POLL_INTERVAL_MS)
        }
        return false
    }

    private fun waitForServiceStopped(timeout: Long): Boolean {
        val deadline = System.currentTimeMillis() + timeout
        while (System.currentTimeMillis() < deadline) {
            if (!isServiceRunning() && !isServiceProcessRunning()) return true
            Thread.sleep(POLL_INTERVAL_MS)
        }
        return false
    }

    private fun stopServiceAndWait() {
        // Same rationale as ServiceLifecycleTest: stopService + direct kill, and
        // the onDestroy killProcess triggers START_STICKY restarts, so repeat.
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

    /**
     * `@comapeo/ipc` round-trip probe on `comapeo.sock`: an rpc-reflector
     * REQUEST (`[0, id, propArray, args]`) on the manager sub-channel. Any
     * RESPONSE (`[1, id, ...]`) — success or error — proves the round trip.
     */
    private fun rpcRequest(requestId: Int): String =
        """{"id":"$MANAGER_CHANNEL_ID","message":[0,$requestId,["getDeviceInfo"],[]]}"""

    private fun awaitRpcResponse(
        responses: List<String>,
        requestId: Int,
        timeoutMs: Long = RPC_TIMEOUT_MS,
    ): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (responses.any { it.contains("[1,$requestId,") }) return true
            Thread.sleep(100)
        }
        return false
    }

    // --- Test ---

    @Test
    fun ipcRecoversAfterServiceProcessKill() {
        val controlSocketFile =
            File(context.filesDir, ComapeoCoreService.CONTROL_SOCKET_FILENAME)
        val comapeoSocketFile =
            File(context.filesDir, ComapeoCoreService.COMAPEO_SOCKET_FILENAME)

        startServiceWithAction(Actions.USER_FOREGROUND)
        assertTrue("Service should start", waitForServiceRunning())

        // Connect to the control socket exactly like ComapeoCoreModule does:
        // reconnect-enabled, deriving lifecycle from the replayed frames.
        val readyCount = AtomicInteger(0)
        val firstReady = CountDownLatch(1)
        val secondReady = CountDownLatch(2)
        controlIpc = NodeJSIPC(controlSocketFile, reconnectOnDrop = true) { message ->
            val type = try {
                JSONObject(message).optString("type")
            } catch (e: Exception) {
                ""
            }
            if (type == "ready") {
                readyCount.incrementAndGet()
                firstReady.countDown()
                secondReady.countDown()
            }
        }

        assertTrue(
            "Backend should report ready within ${READY_TIMEOUT_S}s",
            firstReady.await(READY_TIMEOUT_S, TimeUnit.SECONDS)
        )

        // Message socket client, created before the kill so recovery must come
        // from its own reconnect, and a pre-kill round-trip proving the probe.
        val responses = CopyOnWriteArrayList<String>()
        messageIpc = NodeJSIPC(comapeoSocketFile, reconnectOnDrop = true) { message ->
            responses.add(message)
        }
        messageIpc!!.sendMessage(rpcRequest(101))
        assertTrue(
            "Pre-kill RPC round-trip should succeed",
            awaitRpcResponse(responses, 101)
        )

        // In-place kill of the backend process; the app/test process stays up.
        val initialPid = getServiceProcessPid()
        assertTrue("Service process should have a pid", initialPid != null)
        android.os.Process.killProcess(initialPid!!)

        // START_STICKY restarts the service; the reconnect-enabled control
        // client must receive a second `ready` with NO connect()/sendMessage()
        // nudge — the equivalent of the module-derived state returning to STARTED.
        assertTrue(
            "Control socket should reconnect and see ready again within ${READY_TIMEOUT_S}s",
            secondReady.await(READY_TIMEOUT_S, TimeUnit.SECONDS)
        )
        // >= not ==: each control connection gets a `ready` replay, so a
        // transient drop/reconnect during restart churn can legitimately
        // deliver more than two.
        assertTrue(
            "Should see at least two ready frames, saw ${readyCount.get()}",
            readyCount.get() >= 2
        )
        val restartedPid = getServiceProcessPid()
        assertTrue(
            "Service should be running in a fresh process (was $initialPid, now $restartedPid)",
            restartedPid != null && restartedPid != initialPid
        )

        // The message socket must have auto-reconnected too (no nudge yet)...
        val connectDeadline = System.currentTimeMillis() + 15_000
        while (
            messageIpc!!.connectionState !is NodeJSIPC.State.Connected &&
            System.currentTimeMillis() < connectDeadline
        ) {
            Thread.sleep(POLL_INTERVAL_MS)
        }
        assertTrue(
            "Message socket should auto-reconnect after restart, " +
                "state=${messageIpc!!.connectionState}",
            messageIpc!!.connectionState is NodeJSIPC.State.Connected
        )

        // ...and a round-trip on the same instance must succeed after restart.
        messageIpc!!.sendMessage(rpcRequest(202))
        assertTrue(
            "Post-restart RPC round-trip should succeed",
            awaitRpcResponse(responses, 202)
        )
    }
}
