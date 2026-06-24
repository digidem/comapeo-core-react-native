package com.comapeo.core

import android.app.Application
import android.os.Build
import java.io.File

/**
 * Identifies the separate `:ComapeoCore` foreground-service process.
 *
 * The config plugin injects a call to [isBackendProcess] at the top of the host
 * app's `MainApplication.onCreate`. That process runs the Node backend with no
 * UI, so initialising React Native there would delay the service's
 * `startForeground()` past Android's deadline and ANR the process on cold start.
 * Detection lives here, not in the injected string, so it is testable and shared
 * with the reliability telemetry in [ComapeoCoreService].
 */
object ComapeoProcessGuard {
    /** Backend-service `android:process` suffix. Keep in sync with the
     *  `android:process` attribute in AndroidManifest.xml. */
    const val PROCESS_SUFFIX = ":ComapeoCore"

    /**
     * Current process name, or null if it can't be determined. API 28+ uses the
     * authoritative [Application.getProcessName]; older releases read
     * /proc/self/cmdline (process-local, set by the zygote before `onCreate`)
     * rather than the `ActivityManager.runningAppProcesses` binder IPC.
     */
    fun detectProcessName(): String? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            Application.getProcessName()
        } else {
            try {
                File("/proc/self/cmdline").readText()
                    .takeWhile { it.code != 0 }
                    .trim()
                    .ifEmpty { null }
            } catch (e: Exception) {
                null
            }
        }

    /**
     * True only when the current process is positively identified as the backend
     * process. An undetermined name returns false so the host still initialises
     * React Native — the safe direction, since skipping it in the main process
     * would break the app while a missed guard only risks a recoverable ANR in
     * the headless backend.
     */
    fun isBackendProcess(): Boolean =
        detectProcessName()?.endsWith(PROCESS_SUFFIX) == true
}
