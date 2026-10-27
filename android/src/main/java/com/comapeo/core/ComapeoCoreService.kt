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
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

class ComapeoCoreService : Service() {

    // @Volatile: written from stopService() on both the main thread and the
    // nodeJob's Dispatchers.Default callbacks (onComplete/onError), and read by the
    // self-terminate watchdog coroutine (also Dispatchers.Default). Without it the
    // watchdog could read a stale `true` after the normal teardown already won and
    // fire a spurious self-terminate.
    @Volatile
    private var isServiceStarted: Boolean = false
    private lateinit var nodeJSService: NodeJSService
    // Snapshotted in onCreate, consumed when the Node backend is built lazily in
    // ensureBackendInitialized() after startForeground().
    private var effectiveSentryConfig: SentryConfig? = null
    private var applicationUsageData: Boolean = false
    private var debug: Boolean = false
    private var deviceTags: DeviceTags? = null
    private var sentryUserId: String? = null
    /** Snapshot from prefs at cold start; any later intent is authoritative. */
    private var notificationContent = ServiceNotificationContent()
    private val serviceScope = CoroutineScope(Dispatchers.Default + SupervisorJob())

    /** Active self-terminate watchdog (see [onNodeStateChange]). Armed at most once
     *  per service instance because ERROR is per-instance terminal. `@Volatile` for
     *  cross-thread visibility (written from `applyAndEmit`'s background dispatchers),
     *  mirroring `NodeJSService.startupWatchdogJob`. */
    @Volatile
    private var selfTerminateJob: Job? = null

    companion object {
        // Channel behaviour (importance, sound, badge) is frozen per install once
        // created, so any change to those attributes needs a new id.
        const val CHANNEL_ID = "ComapeoServiceChannel"
        const val NOTIFICATION_ID = 1
        const val COMAPEO_SOCKET_FILENAME = "comapeo.sock"
        const val CONTROL_SOCKET_FILENAME = "control.sock"

        /**
         * Grace between a terminal ERROR and the FGS killing its own process
         * (see [onNodeStateChange]). Long enough that the normal teardown wins
         * when it can — backend error frame → `process.exit(1)` → `onComplete` →
         * `stopService` — and that the FGS-side `error-native` → `error` frame
         * round-trip (~100ms–2s, ARCHITECTURE §5.7) reaches the main app process
         * for precise attribution before the kill. Short enough that a hung
         * process doesn't linger holding the runtime.
         */
        const val SELF_TERMINATE_GRACE_MS = 3_000L

        /** The runtime gate for the FGS notification on API 33+. Below 33
         *  `checkSelfPermission` reports the manifest-declared permission as
         *  granted, so this returns `true` without a runtime grant. Pulled
         *  into the companion as a testable seam (see `NotificationPermissionTest`). */
        internal fun hasPostNotificationsPermission(context: Context): Boolean =
            ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.POST_NOTIFICATIONS,
            ) == PackageManager.PERMISSION_GRANTED

        /** Sends [action] to the service with the host's wording attached. The
         *  caller must be foregrounded: a background `startForegroundService`
         *  throws in the caller's process on API 31+. */
        fun send(context: Context, action: Actions, content: ServiceNotificationContent) {
            val intent = content.applyTo(Intent(context, ComapeoCoreService::class.java))
            intent.action = action.name
            // Cross-process monotonic stamp the FGS reads to backdate the boot.fgs-launch span.
            intent.putExtra(EXTRA_SERVICE_START_ELAPSED_MS, SystemClock.elapsedRealtime())
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        // Serialises persisted-wording reads and writes with their sends, so a
        // lifecycle intent can never carry an older snapshot after a newer one.
        private val contentLock = Any()

        /** Sends [action] with the host's persisted wording attached. */
        fun sendWithPersistedContent(context: Context, action: Actions) {
            synchronized(contentLock) {
                send(context, action, ServiceNotificationContent.read(ServiceNotificationContent.store(context)))
            }
        }

        /** Persists [content] and, while the app is foregrounded, re-sends it so
         *  the shade updates at once; otherwise the next lifecycle intent carries it. */
        fun setNotificationContent(context: Context, content: ServiceNotificationContent) {
            synchronized(contentLock) {
                content.write(ServiceNotificationContent.store(context))
                val foregrounded = ProcessLifecycleOwner.get()
                    .lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
                if (!foregrounded) return
                try {
                    send(context, Actions.USER_FOREGROUND, content)
                } catch (e: IllegalStateException) {
                    log("setNotificationContent: deferred to next foreground: ${e.message}")
                }
            }
        }

        /** Idempotent; a re-create updates only the name and description, which
         *  is how a system-language change reaches Settings. */
        internal fun ensureNotificationChannel(context: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val channel = NotificationChannel(
                CHANNEL_ID,
                context.getString(R.string.comapeo_core_notification_channel_name),
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = context.getString(R.string.comapeo_core_notification_channel_description)
                setSound(null, null)
                // A status notification, not something to read: no launcher dot or count.
                setShowBadge(false)
            }
            (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .createNotificationChannel(channel)
        }

        internal fun buildNotification(
            context: Context,
            content: ServiceNotificationContent,
        ): Notification {
            val body = content.body ?: context.getString(R.string.comapeo_core_notification_body)
            val builder = NotificationCompat.Builder(context, CHANNEL_ID)
                .setContentTitle(content.title ?: context.getString(R.string.comapeo_core_notification_title))
                .setContentText(body)
                .setStyle(NotificationCompat.BigTextStyle().bigText(body))
                .setSmallIcon(R.drawable.ic_map_pin)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setSilent(true)
                .setShowWhen(false)
            context.packageManager.getLaunchIntentForPackage(context.packageName)?.let { launch ->
                builder.setContentIntent(
                    PendingIntent.getActivity(context, 0, launch, PendingIntent.FLAG_IMMUTABLE),
                )
            }
            return builder.build()
        }
    }

    override fun onCreate() {
        super.onCreate()

        // Snapshot-at-boot: `diagnosticsEnabled = false` leaves the FGS bridge inert
        // AND zeroes the `--sentry*` argv passed to loader.mjs (backend short-circuits
        // its own Sentry.init on absent DSN). Restart-to-activate.
        val sentryConfig = SentryConfig.loadFromManifest(applicationContext)
        val prefs = ComapeoPrefs.open(applicationContext)
        effectiveSentryConfig = if (prefs.readDiagnosticsEnabled()) sentryConfig else null
        notificationContent = ServiceNotificationContent.read(ServiceNotificationContent.store(applicationContext))

        // Read debug + usage before SentryFgsBridge.init: readDebugEnabled()
        // may queue the auto_disabled breadcrumb, which init drains — read
        // first or that crumb is lost on the auto-off launch. Independent of
        // the diagnostics gate.
        applicationUsageData = prefs.readApplicationUsageData()
        debug = prefs.readDebugEnabled()

        // Init the Sentry bridge here, not after startForeground: breadcrumbs no-op
        // until it's initialised, so deferring it would drop the pre-start trail.
        // It's cheap relative to the Node backend (libnode load), which is the only
        // part deferred to ensureBackendInitialized() to keep off the FGS deadline.
        effectiveSentryConfig?.let { cfg ->
            sentryUserId = prefs.deriveSentryUserId(applicationUsageData)
            SentryFgsBridge.init(applicationContext, cfg, sentryUserId, applicationUsageData)
        }

        logCrumb(SentryCategories.FGS, "ComapeoCoreService.onCreate")

        // Capture when process name detection fails, which results in react
        // native being loaded in the foreground service process, which
        // increases the risk of ANR on a slow device..
        val detectedProcessName = ComapeoProcessGuard.detectProcessName()
        val backendProcessName = ComapeoProcessGuard.backendProcessName(applicationContext)
        if (detectedProcessName == null || detectedProcessName != backendProcessName) {
            logCapture(
                SentryCategories.FGS,
                "comapeo: backend process-name detection failed",
                level = "warning",
                tags = mapOf(
                    SentryTags.PHASE to SentryTags.PHASE_PROCESS_DETECTION,
                    SentryTags.PROCESS_DETECT_NAME to (detectedProcessName ?: "null"),
                    SentryTags.PROCESS_DETECT_EXPECTED to (backendProcessName ?: "null"),
                    SentryTags.SDK_INT to Build.VERSION.SDK_INT.toString(),
                ),
            )
        }

        deviceTags = DeviceTags.compute(applicationContext)
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
                applicationUsageData = applicationUsageData,
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
            applicationUsageData = applicationUsageData,
            debug = debug,
            deviceTags = deviceTags,
            sentryUserId = sentryUserId,
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
        intent?.let { notificationContent = ServiceNotificationContent.fromIntent(it) }

        logCrumb(
            SentryCategories.FGS,
            "onStartCommand",
            data = mapOf(
                "startId" to startId,
                "action" to (intent?.action ?: "(restart)"),
            ),
        )

        when (intent?.action) {
            // startService re-posts the notification even when already started, so
            // wording carried by the intent is applied either way. A USER_BACKGROUND
            // intent can cold-start this process (the FGS was killed, then the app
            // backgrounded); we were still launched via startForegroundService, so
            // we must promote within the deadline — unless the OS forbids a
            // background start, in which case startService stops us.
            Actions.USER_FOREGROUND.name -> {
                startService(serviceStartElapsedMs, SentryTags.BOOT_KIND_USER_FOREGROUND)
            }

            Actions.USER_BACKGROUND.name -> {
                startService(serviceStartElapsedMs, SentryTags.BOOT_KIND_USER_BACKGROUND)
            }

            Actions.STOP.name -> {
                stopService()
            }

            // Debug-only test seam: force a terminal ERROR with the node thread
            // alive so an instrumented test can assert the self-terminate watchdog
            // kills the process and a USER_FOREGROUND recovers it. Compiled-out
            // behaviour in release — the action is simply ignored.
            Actions.SIMULATE_FATAL_ERROR.name -> {
                if (BuildConfig.DEBUG && isServiceStarted && ::nodeJSService.isInitialized) {
                    log("SIMULATE_FATAL_ERROR: forcing terminal ERROR (debug only)")
                    nodeJSService.forceFatalErrorForTesting()
                } else {
                    log("Ignoring SIMULATE_FATAL_ERROR (release build or service not started)")
                }
            }

            null -> {
                log("Service restarted by system")
                startService(serviceStartElapsedMs, SentryTags.BOOT_KIND_SYSTEM_RESTART)
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
        serviceScope.launch {
            // nodeJSService is built lazily in startService(); a create→destroy with no
            // start path (e.g. an immediate STOP) leaves it uninitialised.
            if (::nodeJSService.isInitialized) {
                try {
                    // Graceful first: stopForTeardown() ships the shutdown frame and joins
                    // the node thread so the runtime closes MapeoManager/SQLite/sockets and
                    // exits cleanly whenever it can — including from ERROR (self-terminate),
                    // where the guarded stop() would refuse. Bounded by withTimeout; on
                    // expiry the catch below force-kills the process.
                    withTimeout(10_000) {
                        nodeJSService.stopForTeardown()
                    }
                } catch (e: Exception) {
                    // Capture before killProcess; the flush below is what gets it on the wire.
                    logCapture(
                        SentryCategories.FGS,
                        "comapeo: FGS stop timeout fired",
                        level = "error",
                        tags = mapOf(
                            SentryTags.TIMEOUT to "fgsStop",
                            SentryTags.PHASE to SentryTags.PHASE_SHUTDOWN_TIMEOUT,
                        ),
                    )
                }
                // Release this instance's scope/IPC even on the timeout path — also
                // cancels in-flight coroutines (watchdog, pending sends) so they can't
                // fire during the flush window below.
                nodeJSService.destroy()
            }
            // node::Start is single-shot per process: the runtime can't be reused by a
            // restart that reuses this process, so always tear the process down. The
            // pending START_STICKY / restart intent cold-starts a fresh process with a
            // clean runtime, sockets, and data dir.
            logCrumb(SentryCategories.FGS, "killProcess: FGS destroyed")
            // 2s flush — long enough to deliver under typical network, short enough
            // not to stall shutdown noticeably.
            SentryFgsBridge.flush(2_000)
            Process.killProcess(Process.myPid())
        }
    }

    /** @return true if the service is (or stays) promoted to the foreground; false if
     *  a background-start restriction forced it to stop. */
    private fun startService(serviceStartElapsedMs: Long, bootKind: String): Boolean {
        log("Starting the foreground service")
        ensureNotificationChannel(this)
        val notification = buildNotification(this, notificationContent)
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

        // Promote to the foreground before building the Node backend: the
        // startForeground deadline runs from the (cold-start) process fork, so the
        // costly libnode load must come after. On failure we stop — see catch.
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
        } catch (e: Exception) {
            // Broad: startForeground has OEM-specific failure modes and an uncaught
            // throw kills the headless process. Whatever the cause, we never
            // foregrounded — stop rather than run a non-foreground backend.
            val (level, phase) = when (e) {
                // ForegroundServiceStartNotAllowedException (API 31+): background start
                // outside the grace period; recovers on the next USER_FOREGROUND.
                is IllegalStateException -> "warning" to SentryTags.PHASE_FGS_START_NOT_ALLOWED
                // Missing FGS-type permission: won't recover by returning to foreground.
                is SecurityException -> "error" to SentryTags.PHASE_FGS_PERMISSION_DENIED
                else -> "error" to SentryTags.PHASE_FGS_START_FAILED
            }
            logCapture(
                SentryCategories.FGS,
                "comapeo: startForeground failed: ${e.message}",
                level = level,
                tags = mapOf(SentryTags.PHASE to phase),
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
        // Arms the self-terminate watchdog on a terminal ERROR. Set before start()
        // so an error during boot (rootkey, startup watchdog) is observed.
        nodeJSService.onStateChange = ::onNodeStateChange
        nodeJSService.start(nodeJSServiceCallback)
        isServiceStarted = true
        return true
    }

    /**
     * FGS self-terminate watchdog. `node::Start` is single-shot per process, so a
     * NodeJSService that reaches a terminal ERROR can't be restarted in place. An
     * ERROR where the node thread is still alive — e.g. a startup-watchdog timeout
     * whose `error-native` frame was dropped — would otherwise pin the process
     * indefinitely, leaving the main app process parked at STARTING because the
     * control socket never closes (the unbounded wait noted in ARCHITECTURE §5.7).
     *
     * We converge every ERROR to a dead process so recovery is uniform: the app
     * re-foregrounds (`ReactActivityLifecycleListener.onResume` → `USER_FOREGROUND`)
     * and cold-starts a fresh process. We go through `stopService()` (which calls
     * `stopSelf`) rather than a bare kill, so `START_STICKY` stays cancelled — the
     * user re-foregrounding is the recovery, not an OS-paced sticky restart.
     *
     * Most ERRORs already self-resolve (backend `process.exit(1)` → `onComplete` →
     * `stopService`); the grace delay lets that path win, and the fire-time
     * `isServiceStarted` recheck makes us a no-op when it does. This watchdog is
     * the backstop for the node-still-alive case. ERROR is per-instance terminal,
     * so `onStateChange(ERROR)` fires at most once and the job is armed once.
     */
    private fun onNodeStateChange(state: NodeJSService.State) {
        if (state != NodeJSService.State.ERROR || selfTerminateJob != null) return
        selfTerminateJob = serviceScope.launch {
            delay(SELF_TERMINATE_GRACE_MS)
            // Node exited on its own → onComplete/onError already ran stopService.
            if (!isServiceStarted) return@launch
            logCapture(
                SentryCategories.FGS,
                "comapeo: FGS self-terminating after terminal ERROR",
                level = "warning",
                tags = mapOf(
                    SentryTags.TIMEOUT to "selfTerminate",
                    SentryTags.PHASE to SentryTags.PHASE_SELF_TERMINATE,
                ),
            )
            // stopService touches the notification manager / stopSelf; keep it on main.
            withContext(Dispatchers.Main) { stopService() }
        }
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

    override fun onBind(p0: Intent): IBinder? {
        return null
    }
}
