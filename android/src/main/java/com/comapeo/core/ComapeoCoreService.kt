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
        /**
         * Tracks the number of active service instances in this process.
         * Used to prevent Process.killProcess() in onDestroy from killing a
         * process that has already created a new service instance (e.g. during
         * a stop→restart cycle where Android reuses the same process).
         */
        @Volatile
        private var activeInstanceCount = 0
    }

    override fun onCreate() {
        super.onCreate()
        activeInstanceCount++

        // Initialise the FGS-process Sentry SDK before anything
        // emits. `loadFromManifest` returns null when the consumer
        // didn't register the plugin, leaving the bridge inert.
        // Forwarded to NodeJSService so it can argv-pass to loader.mjs.
        val sentryConfig = SentryConfig.loadFromManifest(applicationContext)
        sentryConfig?.let { cfg ->
            SentryFgsBridge.init(applicationContext, cfg)
        }

        logCrumb(SentryCategories.FGS, "ComapeoCoreService.onCreate")

        nodeJSService = NodeJSService(
            applicationContext,
            sentryConfig = sentryConfig,
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
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
                // Service restarted by system - check current app state
                val isAppInForeground = ProcessLifecycleOwner.get()
                    .lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)

                log("Service restarted by system - app in foreground: $isAppInForeground")

                startService()
                updateNotification(isAppInForeground)
            }

            else -> log("Unknown action in received intent: ${intent.action}")
        }

        // If the system kills the service after onStartCommand() returns,
        // recreate the service and call onStartCommand(), but do not redeliver
        // the last intent. Instead, the system calls onStartCommand() with a
        // null intent unless there are pending intents to start the service. In
        // that case, those intents are delivered.
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
                // Capture before the killProcess below. The flush
                // call afterwards is what actually gets the event on
                // the wire — without it, async transport can lose
                // the capture under poor network conditions.
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
            // Only kill the process if no new service instance has started.
            // During a stop→restart cycle, Android may create a new instance
            // in the same process before this coroutine completes.
            if (activeInstanceCount <= 0) {
                logCrumb(SentryCategories.FGS, "killProcess: no active instances")
                // Synchronous flush bounded at 2s — short enough to
                // avoid stalling shutdown noticeably, long enough to
                // deliver under typical network conditions. No-op
                // when sentry-android isn't on the classpath.
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

        // Always call startForeground — Android requires it every time
        // startForegroundService() is called, even if already in foreground.
        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            notification,
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            } else {
                0
            }
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
        // depending on the Android API that we're dealing with we will have
        // to use a specific method to create the notification
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
            log("Notification channel created")
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
            .setPriority(NotificationCompat.PRIORITY_DEFAULT) // for under android 26 compatibility
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
        // Create an intent to stop the service
        val stopIntent = Intent(this, ComapeoCoreService::class.java).apply {
            action = Actions.STOP.name
        }

        val pendingIntent = PendingIntent.getService(
            this,
            0,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Action(
            R.drawable.ic_stop,
            "Stop",
            pendingIntent
        )
    }

    override fun onBind(p0: Intent): IBinder? {
        return null
    }
}
