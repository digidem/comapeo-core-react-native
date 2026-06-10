package com.comapeo.core

import android.app.Application
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import expo.modules.core.interfaces.ApplicationLifecycleListener
import io.sentry.Sentry
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Main-process startup hook: reports historical exit reasons for the main
 * process and maintains the wall-clock anchors the next post-mortem derives
 * durations from. The FGS process runs its own collection from
 * [ComapeoCoreService.onCreate].
 */
class ComapeoCoreApplicationLifecycleListener : ApplicationLifecycleListener {

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    override fun onCreate(application: Application) {
        scope.launch {
            // Expo dispatches this in every process that instantiates the host
            // Application, including :ComapeoCore — only the main process
            // belongs here. (Checked inside the coroutine: the pre-28
            // fallback is a binder IPC that mustn't block Application.onCreate.)
            if (currentProcessName(application) != application.packageName) return@launch

            // Snapshot the previous session's anchors before this run stamps
            // its own — the decoder must see what was true at the old exit.
            val anchors = BackgroundAnchors.open(application)
            val snapshot = AnchorSnapshot.from(anchors, SentryTags.PROC_MAIN)
            anchors.writeProcessStartedAtMs(SentryTags.PROC_MAIN, System.currentTimeMillis())
            withContext(Dispatchers.Main) {
                registerBackgroundedAnchorObserver(anchors)
            }

            val prefs = ComapeoPrefs.open(application)
            if (!prefs.readDiagnosticsEnabled()) return@launch
            // Main-process sentry-android comes up only when JS-side
            // Sentry.init runs (manifest sets io.sentry.auto-init=false);
            // capturing earlier silently drops every event. The snapshot
            // above makes waiting safe.
            if (!awaitSentryEnabled()) {
                log("[${SentryCategories.EXIT}] main: Sentry never initialised, leaving exit records pending")
                return@launch
            }
            ExitReasonsCollector.collectAndReport(
                context = application,
                processName = application.packageName,
                procKey = SentryTags.PROC_MAIN,
                captureApplicationData = prefs.readCaptureApplicationData(),
                snapshot = snapshot,
            )
        }
    }

    /** True once `Sentry.isEnabled()`. The RN bundle usually inits Sentry
     *  within seconds; give up after [SENTRY_WAIT_MAX_MS] (host has Sentry
     *  off, or JS crashed pre-init) — records stay pending either way. */
    private suspend fun awaitSentryEnabled(): Boolean {
        var waitedMs = 0L
        while (!Sentry.isEnabled()) {
            if (waitedMs >= SENTRY_WAIT_MAX_MS) return false
            delay(SENTRY_POLL_INTERVAL_MS)
            waitedMs += SENTRY_POLL_INTERVAL_MS
        }
        return true
    }

    /**
     * `ProcessLifecycleOwner` (not the per-Activity listener) so the anchors
     * flip once per whole-process foreground/background transition. ON_START
     * stamps `foregrounded_at` rather than clearing `backgrounded_at`: the
     * FGS process reads these slots on its own (later) cold start, and a
     * cleared value would erase the background window its previous death
     * happened in. The decoder orders both stamps against the exit timestamp.
     */
    private fun registerBackgroundedAnchorObserver(anchors: BackgroundAnchors) {
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                anchors.writeForegroundedAtMs(SentryTags.PROC_MAIN, System.currentTimeMillis())
            }

            override fun onStop(owner: LifecycleOwner) {
                anchors.writeBackgroundedAtMs(SentryTags.PROC_MAIN, System.currentTimeMillis())
            }
        })
    }

    private companion object {
        const val SENTRY_POLL_INTERVAL_MS = 1_000L
        const val SENTRY_WAIT_MAX_MS = 120_000L
    }
}
