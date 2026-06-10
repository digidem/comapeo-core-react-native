package com.comapeo.core

import android.content.Context
import androidx.core.content.edit

/**
 * Wall-clock anchors for exit-reason post-mortems, keyed per process name
 * (`main` / `fgs`). Wall-clock (`System.currentTimeMillis`) rather than
 * `elapsedRealtime` so values survive reboots and cross-process reads.
 * Stored in the same prefs file as the Sentry toggles
 * ([ComapeoPrefs.PREFS_NAME]) — the FGS process reads the main process's
 * `backgrounded_at` slot on its own cold start.
 *
 * Constructor takes read/write lambdas to keep tests free of
 * `SharedPreferences` (unmocked on the JVM unit-test classpath). [open] is
 * the production constructor.
 */
internal class BackgroundAnchors(
    private val readLong: (String) -> Long?,
    private val writeLong: (String, Long) -> Unit,
) {
    fun readProcessStartedAtMs(proc: String): Long? = readLong("$proc.$KEY_PROCESS_STARTED_AT")

    fun writeProcessStartedAtMs(proc: String, wallMs: Long) {
        writeLong("$proc.$KEY_PROCESS_STARTED_AT", wallMs)
    }

    fun readBackgroundedAtMs(proc: String): Long? = readLong("$proc.$KEY_BACKGROUNDED_AT")

    /** `0` means "currently foregrounded" — derived backgrounded-for durations
     *  only count when the death happened during background. */
    fun writeBackgroundedAtMs(proc: String, wallMs: Long) {
        writeLong("$proc.$KEY_BACKGROUNDED_AT", wallMs)
    }

    fun readLastSeenMs(proc: String): Long? = readLong("$proc.$KEY_LAST_SEEN")

    fun writeLastSeenMs(proc: String, wallMs: Long) {
        writeLong("$proc.$KEY_LAST_SEEN", wallMs)
    }

    companion object {
        const val KEY_PROCESS_STARTED_AT = "process_started_at_wall_ms"
        const val KEY_BACKGROUNDED_AT = "backgrounded_at_wall_ms"
        const val KEY_LAST_SEEN = "exit_reasons.last_seen_ms"

        @JvmStatic
        fun open(context: Context): BackgroundAnchors {
            val sp = context.getSharedPreferences(ComapeoPrefs.PREFS_NAME, Context.MODE_PRIVATE)
            return BackgroundAnchors(
                readLong = { key -> if (sp.contains(key)) sp.getLong(key, 0L) else null },
                writeLong = { key, value -> sp.edit { putLong(key, value) } },
            )
        }
    }
}
