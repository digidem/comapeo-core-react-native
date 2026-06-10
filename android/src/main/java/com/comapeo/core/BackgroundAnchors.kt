package com.comapeo.core

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit

/**
 * Wall-clock anchors for exit-reason post-mortems, keyed per process name
 * (`main` / `fgs`). Wall-clock (`System.currentTimeMillis`) rather than
 * `elapsedRealtime` so values survive reboots and cross-process reads.
 *
 * One prefs file per proc slot, and each file has exactly one writer
 * process — `SharedPreferences` is not multi-process safe (every write
 * persists the writer's whole cached map, silently reverting keys another
 * process wrote since this process loaded the file). The FGS process only
 * READS the `main` slots, opening the file at its own cold start, which is
 * fresh enough: the values it needs were written before it was spawned.
 *
 * Constructor takes read/write lambdas to keep tests free of
 * `SharedPreferences` (unmocked on the JVM unit-test classpath). [open] is
 * the production constructor.
 */
internal class BackgroundAnchors(
    private val readLong: (proc: String, key: String) -> Long?,
    private val writeLong: (proc: String, key: String, value: Long) -> Unit,
) {
    fun readProcessStartedAtMs(proc: String): Long? = readLong(proc, KEY_PROCESS_STARTED_AT)

    fun writeProcessStartedAtMs(proc: String, wallMs: Long) {
        writeLong(proc, KEY_PROCESS_STARTED_AT, wallMs)
    }

    fun readBackgroundedAtMs(proc: String): Long? = readLong(proc, KEY_BACKGROUNDED_AT)

    fun writeBackgroundedAtMs(proc: String, wallMs: Long) {
        writeLong(proc, KEY_BACKGROUNDED_AT, wallMs)
    }

    fun readForegroundedAtMs(proc: String): Long? = readLong(proc, KEY_FOREGROUNDED_AT)

    /** Paired with [writeBackgroundedAtMs]: the decoder treats an exit as
     *  "in background" when the last transition before it was a background.
     *  Never cleared — comparing both stamps against the exit timestamp
     *  works regardless of which process reads them, or when. */
    fun writeForegroundedAtMs(proc: String, wallMs: Long) {
        writeLong(proc, KEY_FOREGROUNDED_AT, wallMs)
    }

    fun readLastSeenMs(proc: String): Long? = readLong(proc, KEY_LAST_SEEN)

    fun writeLastSeenMs(proc: String, wallMs: Long) {
        writeLong(proc, KEY_LAST_SEEN, wallMs)
    }

    companion object {
        const val KEY_PROCESS_STARTED_AT = "process_started_at_wall_ms"
        const val KEY_BACKGROUNDED_AT = "backgrounded_at_wall_ms"
        const val KEY_FOREGROUNDED_AT = "foregrounded_at_wall_ms"
        const val KEY_LAST_SEEN = "exit_reasons.last_seen_ms"

        private fun fileFor(proc: String) = "com.comapeo.core.anchors.$proc"

        @JvmStatic
        fun open(context: Context): BackgroundAnchors {
            val sps = mutableMapOf<String, SharedPreferences>()
            fun sp(proc: String): SharedPreferences = synchronized(sps) {
                sps.getOrPut(proc) {
                    context.getSharedPreferences(fileFor(proc), Context.MODE_PRIVATE)
                }
            }
            return BackgroundAnchors(
                readLong = { proc, key ->
                    sp(proc).let { if (it.contains(key)) it.getLong(key, 0L) else null }
                },
                // commit (not apply): `backgrounded_at` lands immediately before
                // the kill window this feature measures — an unflushed apply()
                // dies with the process and misclassifies exactly those kills.
                writeLong = { proc, key, value ->
                    sp(proc).edit(commit = true) { putLong(key, value) }
                },
            )
        }
    }
}
