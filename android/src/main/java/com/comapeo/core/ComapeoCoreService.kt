package com.comapeo.core

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.Process
import android.widget.Toast
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout

class ComapeoCoreService : Service() {

    private var isServiceStarted: Boolean = false
    private lateinit var nodeJSService: NodeJSService
    private val serviceScope = CoroutineScope(Dispatchers.Default + SupervisorJob())

    companion object {
        const val CHANNEL_ID = "ComapeoServiceChannel"
        const val NOTIFICATION_ID = 1
        const val COMAPEO_SOCKET_FILENAME = "comapeo.sock"
        const val CONTROL_SOCKET_FILENAME = "control.sock"

        /** Guards `Process.killProcess` from racing a stop→restart cycle that
         *  reuses the same process and creates a new instance. */
        @Volatile
        private var activeInstanceCount = 0
    }

    override fun onCreate() {
        super.onCreate()
        activeInstanceCount++

        // Snapshot-at-boot: `diagnosticsEnabled = false` leaves the FGS bridge inert
        // AND zeroes the `--sentry*` argv passed to loader.mjs (backend short-circuits
        // its own Sentry.init on absent DSN). Restart-to-activate.
        val sentryConfig = SentryConfig.loadFromManifest(applicationContext)
        val prefs = ComapeoPrefs.open(applicationContext)
        val effectiveConfig = if (prefs.readDiagnosticsEnabled()) sentryConfig else null
        effectiveConfig?.let { cfg ->
            SentryFgsBridge.init(applicationContext, cfg)
        }

        logCrumb(SentryCategories.FGS, "ComapeoCoreService.onCreate")

        val captureApplicationData = prefs.readCaptureApplicationData()
        serviceScope.launch(Dispatchers.IO) {
            // Snapshot the previous FGS session's anchors before stamping
            // this run's — the decoder must see what was true at the old exit.
            val anchors = BackgroundAnchors.open(applicationContext)
            val snapshot = AnchorSnapshot.from(anchors, SentryTags.PROC_FGS)
            anchors.writeProcessStartedAtMs(SentryTags.PROC_FGS, System.currentTimeMillis())
            ExitReasonsCollector.collectAndReport(
                context = applicationContext,
                // Runtime name, not a literal copy of the manifest's
                // android:process — a rename can't silently break the filter.
                processName = currentProcessName(applicationContext),
                procKey = SentryTags.PROC_FGS,
                captureApplicationData = captureApplicationData,
                snapshot = snapshot,
            )
        }

        nodeJSService = NodeJSService(
            applicationContext,
            sentryConfig = effectiveConfig,
            captureApplicationData = captureApplicationData,
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Forward the activity's `serviceStartTimeMs` stamp so
        // NodeJSService can backdate boot.fgs-launch. -1 means the
        // intent didn't carry one (system restart); we'll skip the
        // backdated span in that case.
        val serviceStartElapsedMs =
            intent?.getLongExtra(EXTRA_SERVICE_START_ELAPSED_MS, -1L) ?: -1L
        if (serviceStartElapsedMs >= 0) {
            nodeJSService.serviceStartElapsedMs = serviceStartElapsedMs
        }

        logCrumb(
            SentryCategories.FGS,
            "onStartCommand",
            data = mapOf(
                "startId" to startId,
                "action" to (intent?.action ?: "(restart)"),
            ),
        )

        when (intent?.action) {
            Actions.USER_FOREGROUND.name -> {
                startService()
                updateNotification(true)
            }

            Actions.USER_BACKGROUND.name -> {
                if (isServiceStarted) {
                    updateNotification(false)
                }
            }

            Actions.STOP.name -> {
                stopService()
            }

            null -> {
                // System-driven restart (no intent): recover the foreground/background
                // notification state from the app lifecycle.
                val isAppInForeground = ProcessLifecycleOwner.get()
                    .lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
                log("Service restarted by system - app in foreground: $isAppInForeground")
                startService()
                updateNotification(isAppInForeground)
            }

            else -> log("Unknown action in received intent: ${intent.action}")
        }

        return START_STICKY
    }

    private val nodeJSServiceCallback = object : NodeJSService.Callback {
        override fun onComplete(exitCode: Int) {
            logCrumb(
                SentryCategories.FGS,
                "NodeJS exited",
                data = mapOf("exitCode" to exitCode),
            )
            stopService()
        }

        override fun onError(e: Exception) {
            logCrumb(
                SentryCategories.FGS,
                "NodeJS service error: ${e.message}",
                level = "error",
            )
            stopService()
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        logCrumb(SentryCategories.FGS, "ComapeoCoreService.onDestroy")
        isServiceStarted = false
        activeInstanceCount--
        serviceScope.launch {
            try {
                withTimeout(10_000) {
                    nodeJSService.stop()
                }
            } catch (e: Exception) {
                // Capture before killProcess; the flush below is what gets it on the wire.
                logCapture(
                    SentryCategories.FGS,
                    "comapeo: FGS stop timeout fired",
                    level = "error",
                    tags = mapOf(
                        SentryTags.TIMEOUT to "fgsStop",
                        SentryTags.PHASE to "shutdown-timeout",
                    ),
                )
            }
            if (activeInstanceCount <= 0) {
                logCrumb(SentryCategories.FGS, "killProcess: no active instances")
                // 2s flush — long enough to deliver under typical network, short enough
                // not to stall shutdown noticeably.
                SentryFgsBridge.flush(2_000)
                Process.killProcess(Process.myPid())
            } else {
                log("Skipping process kill — new service instance is active")
            }
        }
    }

    private fun startService() {
        log("Starting the foreground service")
        val notification = createNotification(true)
        // Android requires startForeground on every startForegroundService call.
        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            notification,
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            } else {
                0
            },
        )
        if (isServiceStarted) return
        Toast.makeText(this, "Service starting", Toast.LENGTH_SHORT).show()
        nodeJSService.start(nodeJSServiceCallback)
        isServiceStarted = true
    }

    private fun stopService() {
        log("Stopping the foreground service")
        isServiceStarted = false
        try {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        } catch (e: Exception) {
            log("Service stopped without being started: ${e.message}")
        }
    }

    private fun createNotification(isForeground: Boolean): Notification {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val notificationManager =
                getSystemService(NOTIFICATION_SERVICE) as NotificationManager
            val channel = NotificationChannel(
                CHANNEL_ID,
                "CoMapeo Service channel",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Channel for foreground service"
                setSound(null, null)
            }
            notificationManager.createNotificationChannel(channel)
        }

        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val pendingIntent: PendingIntent =
            PendingIntent.getActivity(this, 0, launchIntent, PendingIntent.FLAG_IMMUTABLE)

        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("CoMapeo")
            .setContentText("Monitoring for nearby devices")
            .setContentIntent(pendingIntent)
            .setProgress(100, 25, true)
            .setSmallIcon(R.drawable.ic_map_pin)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setTicker("Ticker text")

        if (!isForeground) {
            builder.addAction(createStopAction())
        }

        return builder.build()
    }

    private fun updateNotification(isForeground: Boolean) {
        val notification = createNotification(isForeground)
        val notificationManager =
            getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        notificationManager.notify(NOTIFICATION_ID, notification)
    }

    private fun createStopAction(): NotificationCompat.Action {
        val stopIntent = Intent(this, ComapeoCoreService::class.java).apply {
            action = Actions.STOP.name
        }
        val pendingIntent = PendingIntent.getService(
            this,
            0,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Action(R.drawable.ic_stop, "Stop", pendingIntent)
    }

    override fun onBind(p0: Intent): IBinder? {
        return null
    }
}
