package com.comapeo.core

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.Process
import android.os.RemoteCallbackList
import android.widget.Toast
import androidx.core.app.NotificationCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking

enum class ServiceState {
    STOPPED, STARTING, STARTED, STOPPING, ERROR
}

class ComapeoCoreService : Service() {

    private var isServiceStarted: Boolean = false
    private lateinit var nodeJSService: NodeJSService

    private val callbacks = RemoteCallbackList<IServiceCallback>()
    private val _serviceState = MutableStateFlow(ServiceState.STOPPED)

    companion object {
        const val CHANNEL_ID = "ComapeoServiceChannel"
        const val NOTIFICATION_ID = 1
        const val COMAPEO_SOCKET_FILENAME = "comapeo.sock"
        const val STATE_SOCKET_FILENAME = "state.sock"
    }

    override fun onCreate() {
        super.onCreate()
        nodeJSService = NodeJSService(applicationContext)
        log("The service has been created".uppercase())
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        log("onStartCommand startId: $startId action: ${intent?.action}")

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

        // by returning this the service is note restarted if the system kills the service
        return START_STICKY
    }

    private val nodeJSServiceCallback = object : NodeJSService.Callback {
        override fun onComplete(exitCode: Int) {
            log("NodeJS service completed with exit code $exitCode")
            stopService()
        }

        override fun onError(e: Exception) {
            log("NodeJS service error: ${e.message}")
            stopService()
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        log("onDestroy")
        runBlocking {
            nodeJSService.stop()
            log("NodeJS service stopped")
        }
        log("The service has been destroyed".uppercase())
        Toast.makeText(this, "Service destroyed", Toast.LENGTH_SHORT).show()

        Process.killProcess(Process.myPid())
    }

    private fun startService() {
        if (isServiceStarted) return
        log("Starting the foreground service")
        Toast.makeText(this, "Service starting", Toast.LENGTH_SHORT).show()

        val notification = createNotification(true)
        startForeground(NOTIFICATION_ID, notification)
        nodeJSService.start(nodeJSServiceCallback)

        isServiceStarted = true
    }

    private fun stopService() {
        log("Stopping the foreground service")
        // Toast.makeText(this, "Service stopping", Toast.LENGTH_SHORT).show()
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
