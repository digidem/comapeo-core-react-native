package com.comapeo.core

import android.app.ActivityManager.RunningAppProcessInfo
import android.app.ApplicationExitInfo

/**
 * Decode tables for `ApplicationExitInfo` ints → Sentry tag strings.
 * Separate file from [ExitReasonsCollector] so the unit test can exercise
 * the tables without instantiating `ApplicationExitInfo` (which can't be
 * constructed off-device). The `REASON_*` / `IMPORTANCE_*` references are
 * compile-time constants, so this compiles against the JVM test classpath
 * despite the classes being API 30+ at runtime.
 */
internal object ExitReasonTags {

    /** `exit.reason` tag value. Unknown ints → `unknown:<int>` so a future
     *  API level adding reasons degrades to a sliceable string, not a crash. */
    fun decodeReason(reason: Int): String = when (reason) {
        ApplicationExitInfo.REASON_UNKNOWN -> "unknown"
        ApplicationExitInfo.REASON_EXIT_SELF -> "exit_self"
        ApplicationExitInfo.REASON_SIGNALED -> "signaled"
        ApplicationExitInfo.REASON_LOW_MEMORY -> "low_memory"
        ApplicationExitInfo.REASON_CRASH -> "crash"
        ApplicationExitInfo.REASON_CRASH_NATIVE -> "crash_native"
        ApplicationExitInfo.REASON_ANR -> "anr"
        ApplicationExitInfo.REASON_INITIALIZATION_FAILURE -> "initialization_failure"
        ApplicationExitInfo.REASON_PERMISSION_CHANGE -> "permission_change"
        ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "excessive_resource_usage"
        ApplicationExitInfo.REASON_USER_REQUESTED -> "user_requested"
        ApplicationExitInfo.REASON_USER_STOPPED -> "user_stopped"
        ApplicationExitInfo.REASON_DEPENDENCY_DIED -> "dependency_died"
        ApplicationExitInfo.REASON_OTHER -> "other"
        ApplicationExitInfo.REASON_FREEZER -> "freezer"
        ApplicationExitInfo.REASON_PACKAGE_STATE_CHANGE -> "package_state_change"
        ApplicationExitInfo.REASON_PACKAGE_UPDATED -> "package_updated"
        else -> "unknown:$reason"
    }

    /** `exit.process_state` tag value, from `ApplicationExitInfo.getImportance()`. */
    fun decodeImportance(importance: Int): String = when (importance) {
        RunningAppProcessInfo.IMPORTANCE_FOREGROUND -> "foreground"
        RunningAppProcessInfo.IMPORTANCE_FOREGROUND_SERVICE -> "foreground_service"
        RunningAppProcessInfo.IMPORTANCE_TOP_SLEEPING -> "top_sleeping"
        RunningAppProcessInfo.IMPORTANCE_VISIBLE -> "visible"
        RunningAppProcessInfo.IMPORTANCE_PERCEPTIBLE -> "perceptible"
        RunningAppProcessInfo.IMPORTANCE_PERCEPTIBLE_PRE_26 -> "perceptible"
        RunningAppProcessInfo.IMPORTANCE_CANT_SAVE_STATE -> "cant_save_state"
        RunningAppProcessInfo.IMPORTANCE_SERVICE -> "service"
        RunningAppProcessInfo.IMPORTANCE_CACHED -> "cached"
        RunningAppProcessInfo.IMPORTANCE_GONE -> "gone"
        else -> "unknown:$importance"
    }

    /**
     * `exit.severity` attribute per reason. `error` for the system-driven
     * kills the dashboards care about; `warning` where sentry-android already
     * captured the crash/ANR itself (this is just the matching post-mortem
     * record); `info` for intentional or housekeeping exits.
     */
    fun severityFor(reason: Int): String = when (reason) {
        ApplicationExitInfo.REASON_LOW_MEMORY,
        ApplicationExitInfo.REASON_SIGNALED,
        ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE,
        ApplicationExitInfo.REASON_DEPENDENCY_DIED,
        -> "error"

        ApplicationExitInfo.REASON_ANR,
        ApplicationExitInfo.REASON_CRASH,
        ApplicationExitInfo.REASON_CRASH_NATIVE,
        ApplicationExitInfo.REASON_INITIALIZATION_FAILURE,
        -> "warning"

        else -> "info"
    }

    /** User/app chose this exit; dashboards exclude these from kill-rate math. */
    fun isIntentional(reason: Int): Boolean = when (reason) {
        ApplicationExitInfo.REASON_USER_REQUESTED,
        ApplicationExitInfo.REASON_USER_STOPPED,
        ApplicationExitInfo.REASON_EXIT_SELF,
        -> true

        else -> false
    }

    /**
     * SIGKILL to a foreground/foreground-service process bypasses AOSP LMK —
     * the smoking gun for OEM custom killers (MIUI, EMUI, OneUI, …).
     */
    fun isOemKillerSuspected(reason: Int, importance: Int, status: Int): Boolean =
        reason == ApplicationExitInfo.REASON_SIGNALED &&
            status == 9 &&
            (
                importance == RunningAppProcessInfo.IMPORTANCE_FOREGROUND ||
                    importance == RunningAppProcessInfo.IMPORTANCE_FOREGROUND_SERVICE
                )
}
