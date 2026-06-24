package com.comapeo.core

import android.app.Application
import android.content.ComponentName
import android.content.Context
import android.os.Build
import java.io.File

/**
 * Identifies the separate `:ComapeoCore` foreground-service process.
 *
 * `MainApplication.onCreate` runs in every process — both the host UI process and
 * the backend process — and would initialise React Native in both. The backend
 * process is a headless Node foreground service that doesn't use React Native, and
 * initialising it there delays the service's `startForeground()` past Android's
 * deadline, ANRing the process on cold start. The config plugin injects a call to
 * [isBackendProcess] at the top of `MainApplication.onCreate` so that process can
 * skip the init. Detection lives here, not in the injected string, so it is
 * testable and shared with the reliability telemetry in [ComapeoCoreService].
 */
object ComapeoProcessGuard {
    @Volatile
    private var resolvedBackendProcessName: String? = null
    @Volatile
    private var backendProcessNameResolved = false

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
     * The process [ComapeoCoreService] is declared to run in — the manifest's
     * `android:process` (e.g. `<pkg>:ComapeoCore`) — or null if it can't be
     * resolved. Read from the manifest so it is the single source of truth and
     * can't drift from a hardcoded copy. Memoised; constant per process.
     */
    fun backendProcessName(context: Context): String? {
        if (backendProcessNameResolved) return resolvedBackendProcessName
        resolvedBackendProcessName = try {
            context.packageManager
                .getServiceInfo(ComponentName(context, ComapeoCoreService::class.java), 0)
                .processName
        } catch (e: Exception) {
            null
        }
        backendProcessNameResolved = true
        return resolvedBackendProcessName
    }

    /**
     * True only when the current process is positively identified as the backend
     * process. An undetermined name — or a service that resolves to the main
     * process (no private `:` process) — returns false so the host still
     * initialises React Native: the safe direction, since skipping it in the main
     * process would break the app while a missed guard only risks a recoverable
     * ANR in the headless backend.
     */
    fun isBackendProcess(context: Context): Boolean {
        val backend = backendProcessName(context) ?: return false
        if (!backend.contains(':')) return false
        return detectProcessName() == backend
    }
}
