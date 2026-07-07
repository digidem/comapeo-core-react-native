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
 * Sole exception: [resetExitTelemetryAnchors] (main process, toggle
 * re-enable) also writes the `fgs` slots — the FGS only writes its own file
 * in a burst at its cold start, so a reset racing that narrow window (and
 * being reverted by the FGS's stale cached map) is a tolerable best-effort
 * gap.
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

    /**
     * Reset the exit-telemetry anchors to [nowMs] on a diagnostics /
     * application-usage-data off → on flip (§9b.9): the high-water marks so
     * exits recorded during the opted-out window are never reported, and the
     * duration anchors so post-re-enable exits can't report durations
     * spanning it. `backgrounded_at` stays — the fresh `foregrounded_at`
     * already neutralises it for later exits (the user is in the foreground
     * to flip the toggle), and equal stamps would misread as "in background
     * since the reset".
     */
    fun resetExitTelemetryAnchors(nowMs: Long) {
        for (proc in listOf(SentryTags.PROC_MAIN, SentryTags.PROC_FGS)) {
            writeLastSeenMs(proc, nowMs)
            writeProcessStartedAtMs(proc, nowMs)
        }
        writeForegroundedAtMs(SentryTags.PROC_MAIN, nowMs)
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
