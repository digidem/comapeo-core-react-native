package com.comapeo.core

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.widget.Toast
import android.app.PendingIntent
import androidx.core.app.NotificationCompat

class ComapeoCoreService : Service() {

    private var isServiceStarted: Boolean = false

    companion object {
        init {
            System.loadLibrary("comapeo-core-react-native")
            log(getCurrentABIName())
        }

        const val CHANNEL_ID = "ComapeoServiceChannel"
        const val NOTIFICATION_ID = 1

        @JvmStatic
        external fun getCurrentABIName(): String

        @JvmStatic
        external fun initialize(path: String)
    }

    override fun onCreate() {
        super.onCreate()
        initialize(applicationContext.filesDir.absolutePath)
        log("The service has been created".uppercase())
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        log("onStartCommand executed with startId: $startId")

        when (intent?.action) {
            Actions.USER_FOREGROUND.name -> {
                startService()
                updateNotification(true)
                return START_STICKY
            }
            Actions.USER_BACKGROUND.name -> {
                updateNotification(false)
                return START_STICKY
            }
            Actions.STOP.name -> {
                stopService()
                return START_NOT_STICKY
            }
            else -> log("This should never happen. No action in the received intent")
        }

        // by returning this we make sure the service is restarted if the system kills the service
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? {
        return null
    }

    override fun onDestroy() {
        super.onDestroy()
        log("The service has been destroyed".uppercase())
        Toast.makeText(this, "Service destroyed", Toast.LENGTH_SHORT).show()
    }

    private fun startService() {
        if (isServiceStarted) return
        log("Starting the foreground service")
        Toast.makeText(this, "Service starting", Toast.LENGTH_SHORT).show()

        val notification = createNotification(true)
        startForeground(NOTIFICATION_ID, notification)
        isServiceStarted = true
    }

    private fun stopService() {
        log("Stopping the foreground service")
        Toast.makeText(this, "Service stopping", Toast.LENGTH_SHORT).show()
        try {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        } catch (e: Exception) {
            log("Service stopped without being started: ${e.message}")
        }
        isServiceStarted = false
    }

    private fun createNotification(isForeground: Boolean): Notification {
        // depending on the Android API that we're dealing with we will have
        // to use a specific method to create the notification
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
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
        val pendingIntent: PendingIntent = PendingIntent.getActivity(this, 0, launchIntent, PendingIntent.FLAG_IMMUTABLE)

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
        val notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
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

}
