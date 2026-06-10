package com.comapeo.core

import android.app.ActivityManager
import android.app.Application
import android.content.Context
import android.os.Build
import android.os.Process
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import expo.modules.core.interfaces.ApplicationLifecycleListener
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
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
        // Expo dispatches this in every process that instantiates the host
        // Application, including :ComapeoCore — only the main process belongs here.
        if (currentProcessName(application) != application.packageName) return

        scope.launch {
            // Collect BEFORE stamping anchors or registering the lifecycle
            // observer: the decoder must read the previous session's
            // `process_started_at` / `backgrounded_at`, and observer
            // registration replays ON_START, which clears the latter.
            val captureApplicationData =
                ComapeoPrefs.open(application).readCaptureApplicationData()
            ExitReasonsCollector.collectAndReport(
                context = application,
                processName = application.packageName,
                procKey = SentryTags.PROC_MAIN,
                captureApplicationData = captureApplicationData,
            )
            val anchors = BackgroundAnchors.open(application)
            anchors.writeProcessStartedAtMs(SentryTags.PROC_MAIN, System.currentTimeMillis())
            withContext(Dispatchers.Main) {
                registerBackgroundedAnchorObserver(anchors)
            }
        }
    }

    /**
     * `ProcessLifecycleOwner` (not the per-Activity listener) so the anchor
     * flips once per whole-process foreground/background transition. If the
     * app is already started when this registers, the replayed ON_START
     * clears the slot — correct, since any pending value was consumed by the
     * collection that ran first.
     */
    private fun registerBackgroundedAnchorObserver(anchors: BackgroundAnchors) {
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                anchors.writeBackgroundedAtMs(SentryTags.PROC_MAIN, 0L)
            }

            override fun onStop(owner: LifecycleOwner) {
                anchors.writeBackgroundedAtMs(SentryTags.PROC_MAIN, System.currentTimeMillis())
            }
        })
    }

    private fun currentProcessName(context: Context): String =
        if (Build.VERSION.SDK_INT >= 28) {
            Application.getProcessName()
        } else {
            val pid = Process.myPid()
            val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            am.runningAppProcesses?.firstOrNull { it.pid == pid }?.processName
                ?: context.packageName
        }
}
