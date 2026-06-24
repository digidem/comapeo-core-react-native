package com.comapeo.core

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.Process
import android.widget.Toast
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
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
    // Snapshotted in onCreate, consumed when the Node backend is built lazily in
    // ensureBackendInitialized() after startForeground().
    private var effectiveSentryConfig: SentryConfig? = null
    private var captureApplicationData: Boolean = false
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

        /** The runtime gate for the FGS notification on API 33+. Below 33
         *  `checkSelfPermission` reports the manifest-declared permission as
         *  granted, so this returns `true` without a runtime grant. Pulled
         *  into the companion as a testable seam (see `NotificationPermissionTest`). */
        internal fun hasPostNotificationsPermission(context: Context): Boolean =
            ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.POST_NOTIFICATIONS,
            ) == PackageManager.PERMISSION_GRANTED
    }

    override fun onCreate() {
        super.onCreate()
        activeInstanceCount++

        // Snapshot-at-boot: `diagnosticsEnabled = false` leaves the FGS bridge inert
        // AND zeroes the `--sentry*` argv passed to loader.mjs (backend short-circuits
        // its own Sentry.init on absent DSN). Restart-to-activate.
        val sentryConfig = SentryConfig.loadFromManifest(applicationContext)
        val prefs = ComapeoPrefs.open(applicationContext)
        effectiveSentryConfig = if (prefs.readDiagnosticsEnabled()) sentryConfig else null
        captureApplicationData = prefs.readCaptureApplicationData()

        // Init the Sentry bridge here, not after startForeground: breadcrumbs no-op
        // until it's initialised, so deferring it would drop the pre-start trail.
        // It's cheap relative to the Node backend (libnode load), which is the only
        // part deferred to ensureBackendInitialized() to keep off the FGS deadline.
        effectiveSentryConfig?.let { cfg ->
            SentryFgsBridge.init(applicationContext, cfg)
        }

        logCrumb(SentryCategories.FGS, "ComapeoCoreService.onCreate")

        // This service runs only in the :ComapeoCore process, so detection MUST
        // resolve to that process here. If it doesn't, the host MainApplication
        // guard would also have failed to skip RN init — capture it to measure
        // detection reliability in the field (notably the pre-28 /proc path).
        val detectedProcessName = ComapeoProcessGuard.detectProcessName()
        val backendProcessName = ComapeoProcessGuard.backendProcessName(applicationContext)
        if (detectedProcessName == null || detectedProcessName != backendProcessName) {
            logCapture(
                SentryCategories.FGS,
                "comapeo: backend process-name detection failed",
                level = "warning",
                tags = mapOf(
                    SentryTags.PHASE to "process-detection",
                    SentryTags.PROCESS_DETECT_NAME to (detectedProcessName ?: "null"),
                    SentryTags.PROCESS_DETECT_EXPECTED to (backendProcessName ?: "null"),
                    SentryTags.SDK_INT to Build.VERSION.SDK_INT.toString(),
                ),
            )
        }

        // Report the previous FGS process's exit reason and stamp this run's start
        // anchor. Must run for every process lifecycle — even one that never reaches
        // startForeground — so it stays in onCreate. Async on IO; off the deadline.
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
    }

    /** Builds the Node backend. Deferred out of onCreate and called only after
     *  startForeground(), so loading libnode via NodeJSService's static initializer
     *  can't race the FGS deadline. */
    private fun ensureBackendInitialized() {
        if (::nodeJSService.isInitialized) return
        nodeJSService = NodeJSService(
            applicationContext,
            sentryConfig = effectiveSentryConfig,
            captureApplicationData = captureApplicationData,
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Forward the activity's `serviceStartTimeMs` stamp so
        // NodeJSService can backdate boot.fgs-launch. -1 means the
        // intent didn't carry one (system restart); we'll skip the
        // backdated span in that case. Applied in startService(), once
        // the backend exists.
        val serviceStartElapsedMs =
            intent?.getLongExtra(EXTRA_SERVICE_START_ELAPSED_MS, -1L) ?: -1L

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
                if (startService(serviceStartElapsedMs, SentryTags.BOOT_KIND_USER_FOREGROUND)) {
                    updateNotification(true)
                }
            }

            Actions.USER_BACKGROUND.name -> {
                // A USER_BACKGROUND intent can cold-start this process (the FGS was
                // killed, then the app backgrounded). We were still launched via
                // startForegroundService, so we must promote within the deadline —
                // unless the OS forbids a background start, in which case startService
                // stops us and we skip the notification update.
                if (isServiceStarted) {
                    updateNotification(false)
                } else if (startService(serviceStartElapsedMs, SentryTags.BOOT_KIND_USER_BACKGROUND)) {
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
                if (startService(serviceStartElapsedMs, SentryTags.BOOT_KIND_SYSTEM_RESTART)) {
                    updateNotification(isAppInForeground)
                }
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
            // nodeJSService is built lazily in startService(); a create→destroy with no
            // start path (e.g. an immediate STOP) leaves it uninitialised.
            if (::nodeJSService.isInitialized) {
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

    /** @return true if the service is (or stays) promoted to the foreground; false if
     *  a background-start restriction forced it to stop. */
    private fun startService(serviceStartElapsedMs: Long, bootKind: String): Boolean {
        log("Starting the foreground service")
        val notification = createNotification(true)
        // On API 33+ the FGS notification is suppressed without a runtime
        // POST_NOTIFICATIONS grant, which lets the system deprioritise or kill
        // the service. The host app is responsible for requesting the grant
        // (ComapeoCore.requestNotificationPermissionsAsync); here we only log
        // so a missing grant degrades gracefully instead of crashing. See
        // docs/ForegroundService.md.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            !hasPostNotificationsPermission(this)
        ) {
            logCrumb(
                SentryCategories.FGS,
                "POST_NOTIFICATIONS not granted; FGS notification may be suppressed",
                level = "warning",
            )
        }

        // Promote to the foreground FIRST, before building the Node backend below —
        // the startForeground deadline starts at the (cold-start) process fork.
        // A missing notification grant can surface as a SecurityException on some
        // OEM builds; catch it so the service keeps running deprioritised.
        try {
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
        } catch (e: SecurityException) {
            logCapture(
                SentryCategories.FGS,
                "comapeo: startForeground denied (POST_NOTIFICATIONS missing?): ${e.message}",
                level = "warning",
                tags = mapOf(SentryTags.PHASE to "fgs-notification-permission"),
            )
        } catch (e: IllegalStateException) {
            // API 31+ ForegroundServiceStartNotAllowedException (an IllegalStateException,
            // so the SecurityException catch above misses it): a background start outside
            // the grace period, e.g. a USER_BACKGROUND intent that cold-starts this
            // process. We can't promote, so stop cleanly instead of crashing the headless
            // process — the next USER_FOREGROUND start will succeed.
            logCapture(
                SentryCategories.FGS,
                "comapeo: startForeground not allowed from background: ${e.message}",
                level = "warning",
                tags = mapOf(SentryTags.PHASE to "fgs-start-not-allowed"),
            )
            stopService()
            return false
        }
        if (isServiceStarted) return true

        ensureBackendInitialized()
        if (serviceStartElapsedMs >= 0) {
            nodeJSService.serviceStartElapsedMs = serviceStartElapsedMs
        }
        nodeJSService.bootKind = bootKind
        Toast.makeText(this, "Service starting", Toast.LENGTH_SHORT).show()
        nodeJSService.start(nodeJSServiceCallback)
        isServiceStarted = true
        return true
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
