package com.comapeo.core

import android.app.ActivityManager.RunningAppProcessInfo
import android.app.ApplicationExitInfo
import io.sentry.SentryLevel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Decode-table coverage for [ExitReasonTags]. Every enum value the AOSP
 * javadoc lists, plus the fallthrough for unknown ints — newer API levels
 * can add reasons and we want `unknown:<int>` rather than a crash.
 */
class ExitReasonTagsTest {

    @Test
    fun decodeReasonCoversEveryDocumentedValue() {
        val expected = mapOf(
            ApplicationExitInfo.REASON_UNKNOWN to "unknown",
            ApplicationExitInfo.REASON_EXIT_SELF to "exit_self",
            ApplicationExitInfo.REASON_SIGNALED to "signaled",
            ApplicationExitInfo.REASON_LOW_MEMORY to "low_memory",
            ApplicationExitInfo.REASON_CRASH to "crash",
            ApplicationExitInfo.REASON_CRASH_NATIVE to "crash_native",
            ApplicationExitInfo.REASON_ANR to "anr",
            ApplicationExitInfo.REASON_INITIALIZATION_FAILURE to "initialization_failure",
            ApplicationExitInfo.REASON_PERMISSION_CHANGE to "permission_change",
            ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE to "excessive_resource_usage",
            ApplicationExitInfo.REASON_USER_REQUESTED to "user_requested",
            ApplicationExitInfo.REASON_USER_STOPPED to "user_stopped",
            ApplicationExitInfo.REASON_DEPENDENCY_DIED to "dependency_died",
            ApplicationExitInfo.REASON_OTHER to "other",
            ApplicationExitInfo.REASON_FREEZER to "freezer",
            ApplicationExitInfo.REASON_PACKAGE_STATE_CHANGE to "package_state_change",
            ApplicationExitInfo.REASON_PACKAGE_UPDATED to "package_updated",
        )
        for ((reason, tag) in expected) {
            assertEquals(tag, ExitReasonTags.decodeReason(reason))
        }
    }

    @Test
    fun decodeReasonFallsThroughToUnknownInt() {
        assertEquals("unknown:99", ExitReasonTags.decodeReason(99))
    }

    @Test
    fun decodeImportanceCoversDocumentedValues() {
        val expected = mapOf(
            RunningAppProcessInfo.IMPORTANCE_FOREGROUND to "foreground",
            RunningAppProcessInfo.IMPORTANCE_FOREGROUND_SERVICE to "foreground_service",
            RunningAppProcessInfo.IMPORTANCE_TOP_SLEEPING to "top_sleeping",
            RunningAppProcessInfo.IMPORTANCE_VISIBLE to "visible",
            RunningAppProcessInfo.IMPORTANCE_PERCEPTIBLE to "perceptible",
            RunningAppProcessInfo.IMPORTANCE_PERCEPTIBLE_PRE_26 to "perceptible",
            RunningAppProcessInfo.IMPORTANCE_CANT_SAVE_STATE to "cant_save_state",
            RunningAppProcessInfo.IMPORTANCE_SERVICE to "service",
            RunningAppProcessInfo.IMPORTANCE_CACHED to "cached",
            RunningAppProcessInfo.IMPORTANCE_GONE to "gone",
        )
        for ((importance, tag) in expected) {
            assertEquals(tag, ExitReasonTags.decodeImportance(importance))
        }
    }

    @Test
    fun decodeImportanceFallsThroughToUnknownInt() {
        assertEquals("unknown:7777", ExitReasonTags.decodeImportance(7777))
    }

    @Test
    fun levelMapping() {
        val errors = listOf(
            ApplicationExitInfo.REASON_LOW_MEMORY,
            ApplicationExitInfo.REASON_SIGNALED,
            ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE,
            ApplicationExitInfo.REASON_DEPENDENCY_DIED,
        )
        val warnings = listOf(
            ApplicationExitInfo.REASON_ANR,
            ApplicationExitInfo.REASON_CRASH,
            ApplicationExitInfo.REASON_CRASH_NATIVE,
            ApplicationExitInfo.REASON_INITIALIZATION_FAILURE,
        )
        val infos = listOf(
            ApplicationExitInfo.REASON_USER_REQUESTED,
            ApplicationExitInfo.REASON_USER_STOPPED,
            ApplicationExitInfo.REASON_EXIT_SELF,
            ApplicationExitInfo.REASON_PACKAGE_STATE_CHANGE,
            ApplicationExitInfo.REASON_PACKAGE_UPDATED,
            ApplicationExitInfo.REASON_PERMISSION_CHANGE,
            ApplicationExitInfo.REASON_OTHER,
            ApplicationExitInfo.REASON_FREEZER,
            ApplicationExitInfo.REASON_UNKNOWN,
            99, // unknown int
        )
        errors.forEach { assertEquals("reason $it", SentryLevel.ERROR, ExitReasonTags.levelFor(it)) }
        warnings.forEach { assertEquals("reason $it", SentryLevel.WARNING, ExitReasonTags.levelFor(it)) }
        infos.forEach { assertEquals("reason $it", SentryLevel.INFO, ExitReasonTags.levelFor(it)) }
    }

    @Test
    fun intentionalExits() {
        assertTrue(ExitReasonTags.isIntentional(ApplicationExitInfo.REASON_USER_REQUESTED))
        assertTrue(ExitReasonTags.isIntentional(ApplicationExitInfo.REASON_USER_STOPPED))
        assertTrue(ExitReasonTags.isIntentional(ApplicationExitInfo.REASON_EXIT_SELF))
        assertFalse(ExitReasonTags.isIntentional(ApplicationExitInfo.REASON_LOW_MEMORY))
        assertFalse(ExitReasonTags.isIntentional(ApplicationExitInfo.REASON_SIGNALED))
        assertFalse(ExitReasonTags.isIntentional(ApplicationExitInfo.REASON_PACKAGE_UPDATED))
    }

    @Test
    fun oemKillerRequiresSigkillToForegroundProcess() {
        // The headline cohort: SIGKILL (9) + foreground or foreground-service.
        assertTrue(
            ExitReasonTags.isOemKillerSuspected(
                ApplicationExitInfo.REASON_SIGNALED,
                RunningAppProcessInfo.IMPORTANCE_FOREGROUND_SERVICE,
                9,
            ),
        )
        assertTrue(
            ExitReasonTags.isOemKillerSuspected(
                ApplicationExitInfo.REASON_SIGNALED,
                RunningAppProcessInfo.IMPORTANCE_FOREGROUND,
                9,
            ),
        )
        // Wrong signal: SIGTERM is a polite kill, not the OEM-killer signature.
        assertFalse(
            ExitReasonTags.isOemKillerSuspected(
                ApplicationExitInfo.REASON_SIGNALED,
                RunningAppProcessInfo.IMPORTANCE_FOREGROUND_SERVICE,
                15,
            ),
        )
        // Cached process SIGKILL is ordinary LMK behaviour.
        assertFalse(
            ExitReasonTags.isOemKillerSuspected(
                ApplicationExitInfo.REASON_SIGNALED,
                RunningAppProcessInfo.IMPORTANCE_CACHED,
                9,
            ),
        )
        // Non-signaled reasons never qualify.
        assertFalse(
            ExitReasonTags.isOemKillerSuspected(
                ApplicationExitInfo.REASON_LOW_MEMORY,
                RunningAppProcessInfo.IMPORTANCE_FOREGROUND_SERVICE,
                9,
            ),
        )
    }
}
