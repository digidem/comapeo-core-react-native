package com.comapeo.core

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build
import android.util.Log
import androidx.annotation.RequiresApi
import io.sentry.Breadcrumb
import io.sentry.Sentry
import io.sentry.metrics.SentryMetricsParameters

/** The `ApplicationExitInfo` fields the decoder reads, as a plain data class
 *  so JVM tests can hand-build records (the real class can't be constructed
 *  off-device). */
internal data class ExitRecord(
    val processName: String,
    val reason: Int,
    val status: Int,
    val importance: Int,
    val timestampMs: Long,
    val pssKb: Long,
    val rssKb: Long,
    val description: String?,
)

/** Decoded emission for one exit record: a `comapeo.app.exit` count of 1
 *  with these attributes. */
internal data class ExitReasonMetric(
    val attributes: Map<String, Any>,
)

/**
 * The previous session's anchors, read BEFORE the current run stamps its own
 * `process_started_at` / `foregrounded_at` — capturing them as a value lets
 * callers stamp immediately and defer the (Sentry-dependent) collection.
 */
internal data class AnchorSnapshot(
    val processStartedAtMs: Long?,
    val mainBackgroundedAtMs: Long?,
    val mainForegroundedAtMs: Long?,
) {
    companion object {
        fun from(anchors: BackgroundAnchors, procKey: String) = AnchorSnapshot(
            processStartedAtMs = anchors.readProcessStartedAtMs(procKey),
            mainBackgroundedAtMs = anchors.readBackgroundedAtMs(SentryTags.PROC_MAIN),
            mainForegroundedAtMs = anchors.readForegroundedAtMs(SentryTags.PROC_MAIN),
        )
    }
}

/**
 * Surfaces `ActivityManager.getHistoricalProcessExitReasons()` records to
 * Sentry on the next process start. One `comapeo.app.exit` count metric per
 * record newer than the per-process high-water timestamp — metrics, not
 * events, because the goal is aggregate statistics ("which OEMs kill our
 * process hardest"), not per-incident triage in the Issues UI. Attribute
 * taxonomy in `docs/sentry-integration.md`.
 *
 * Two callers — main process ([ComapeoCoreApplicationLifecycleListener]) and
 * the FGS process ([ComapeoCoreService]) — each reporting its own process
 * name only, so Sentry never sees cross-process duplicates.
 *
 * Privacy tiers: the coarse duration buckets (`uptime_bucket`,
 * `bg_duration_bucket`, `comapeo.fgs.killed_in_background`) are
 * low-resolution aggregate data and flow at the diagnostic tier; the exact
 * millisecond durations are usage-shape data and only flow when
 * application-usage-data is on.
 */
internal class ExitReasonsCollector(
    private val anchors: BackgroundAnchors,
    private val snapshot: AnchorSnapshot,
    private val applicationUsageData: Boolean,
    private val nowMs: () -> Long = System::currentTimeMillis,
) {
    /** [newLastSeenMs] is non-null when there are metrics to report; the
     *  caller persists it only AFTER the captures run, so a record consumed
     *  by a failed report stays pending for the next start. */
    data class CollectResult(
        val metrics: List<ExitReasonMetric>,
        val newLastSeenMs: Long?,
    )

    /**
     * Filter + decode [records]. First observation (no high-water key)
     * initialises the high-water to "now" and emits nothing — reporting the
     * pre-feature backlog on every device's first update would flood Sentry
     * with stale deaths.
     */
    fun collect(processName: String, procKey: String, records: List<ExitRecord>): CollectResult {
        val lastSeen = anchors.readLastSeenMs(procKey)
        if (lastSeen == null) {
            anchors.writeLastSeenMs(procKey, nowMs())
            return CollectResult(emptyList(), null)
        }
        val kept = records
            .filter { it.processName == processName && it.timestampMs > lastSeen }
            .sortedBy { it.timestampMs }
            .takeLast(MAX_RECORDS)
        if (kept.isEmpty()) return CollectResult(emptyList(), null)
        return CollectResult(kept.map { decode(it, procKey) }, kept.last().timestampMs)
    }

    private fun decode(record: ExitRecord, procKey: String): ExitReasonMetric {
        val attributes = buildMap {
            put(SentryTags.PROC, procKey)
            put(SentryTags.EXIT_REASON, ExitReasonTags.decodeReason(record.reason))
            put(SentryTags.EXIT_PROCESS_STATE, ExitReasonTags.decodeImportance(record.importance))
            if (record.reason == ApplicationExitInfo.REASON_SIGNALED) {
                put(SentryTags.EXIT_SIGNAL, record.status.toString())
            }
            put(SentryTags.EXIT_INTENTIONAL, ExitReasonTags.isIntentional(record.reason))
            put(
                SentryTags.OEM_KILLER_SUSPECTED,
                ExitReasonTags.isOemKillerSuspected(record.reason, record.importance, record.status),
            )
            put(SentryTags.EXIT_SEVERITY, ExitReasonTags.severityFor(record.reason))
            record.description?.let { put("description", it) }
            put("pss_kb", record.pssKb)
            put("rss_kb", record.rssKb)
            put("exit_timestamp_ms", record.timestampMs)

            val aliveForMs = durationTo(record.timestampMs, snapshot.processStartedAtMs)
            // The FGS has no foreground/background concept; both procs derive
            // the backgrounded-for cohort from the main process's anchors.
            val backgroundedForMs = backgroundedForMs(
                record.timestampMs,
                snapshot.mainBackgroundedAtMs,
                snapshot.mainForegroundedAtMs,
            )
            put(SentryTags.UPTIME_BUCKET, uptimeBucket(aliveForMs))
            put(SentryTags.BG_DURATION_BUCKET, bgDurationBucket(backgroundedForMs))
            if (procKey == SentryTags.PROC_FGS) {
                put(SentryTags.FGS_KILLED_IN_BACKGROUND, backgroundedForMs != null)
            }
            if (applicationUsageData) {
                aliveForMs?.let { put("alive_for_ms", it) }
                if (procKey == SentryTags.PROC_MAIN) {
                    backgroundedForMs?.let { put("backgrounded_for_ms", it) }
                }
            }
        }
        return ExitReasonMetric(attributes)
    }

    companion object {
        /** One count per exit, sliceable by attribute in Sentry's Explore UI. */
        const val METRIC_NAME = "comapeo.app.exit"

        /** Per-process cap after filtering. The OS retains only a handful of
         *  records per package anyway (~16 on AOSP); this just bounds a
         *  pathological burst. */
        private const val MAX_RECORDS = 10

        /** Same budget as [SentryFgsBridge.flush] on shutdown — long enough
         *  to drain the metrics batch under typical network, short enough
         *  not to stall the startup coroutine noticeably. */
        private const val FLUSH_TIMEOUT_MS = 2_000L

        /**
         * Production entry point. Query → decode → capture → flush, then
         * advance the high-water mark — in that order, so a capture that
         * never ran (or a process death mid-report) re-surfaces the records
         * on the next start instead of silently consuming them. The flush
         * matters: metrics sit in an in-memory 5s batch with no disk
         * persistence, so without it a kill right after collection (an FGS
         * start under an OEM killer — the population this measures) would
         * lose the batch while the mark write consumed the records.
         * At-least-once: a death between flush and the mark write re-emits
         * duplicates, a tolerable overcount in aggregate stats.
         *
         * No-op while Sentry is uninitialised (`Sentry.metrics()` would
         * silently drop everything): main-process callers must wait for the
         * JS-triggered init, the FGS caller runs after [SentryFgsBridge.init].
         * Callers schedule this off the main thread.
         */
        @JvmStatic
        fun collectAndReport(
            context: Context,
            processName: String,
            procKey: String,
            applicationUsageData: Boolean,
            snapshot: AnchorSnapshot,
        ) {
            if (Build.VERSION.SDK_INT < 30) {
                // One boot-time scope tag so dashboards can exclude pre-30
                // devices from death-rate math.
                try {
                    Sentry.configureScope { scope ->
                        scope.setTag(SentryTags.EXIT_REASONS_SUPPORTED, "false")
                    }
                } catch (t: Throwable) {
                    Log.w(TAG, "exitReasons supported-tag write threw", t)
                }
                return
            }
            try {
                if (!Sentry.isEnabled()) {
                    log("[${SentryCategories.EXIT}] $procKey: Sentry not initialised, leaving exit records pending")
                    return
                }
                val anchors = BackgroundAnchors.open(context)
                val result = ExitReasonsCollector(
                    anchors = anchors,
                    snapshot = snapshot,
                    applicationUsageData = applicationUsageData,
                ).collect(processName, procKey, queryRecords(context))
                log("[${SentryCategories.EXIT}] $procKey: ${result.metrics.size} new exit record(s)")
                if (result.metrics.isEmpty()) return
                addRunBreadcrumb(procKey, result.metrics.size)
                result.metrics.forEach(::capture)
                Sentry.flush(FLUSH_TIMEOUT_MS)
                result.newLastSeenMs?.let { anchors.writeLastSeenMs(procKey, it) }
            } catch (t: Throwable) {
                // Observability is decorative; a thrown collector must never
                // take either process down.
                Log.w(TAG, "ExitReasonsCollector.collectAndReport threw", t)
            }
        }

        @RequiresApi(30)
        private fun queryRecords(context: Context): List<ExitRecord> {
            val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            // maxNum=0 = no limit: pid=0 makes the window package-wide (both
            // processes share it), so a per-call cap would let one process's
            // churn evict the other's records. The OS bounds retention itself.
            return am.getHistoricalProcessExitReasons(context.packageName, 0, 0)
                .map { info ->
                    ExitRecord(
                        processName = info.processName,
                        reason = info.reason,
                        status = info.status,
                        importance = info.importance,
                        timestampMs = info.timestamp,
                        pssKb = info.pss,
                        rssKb = info.rss,
                        // traceInputStream() is deliberately not captured — it can
                        // exceed Sentry's payload limits and carry user-context
                        // strings on some vendors. `description` is a short label.
                        description = info.description,
                    )
                }
        }

        /** Coarse cohort axis for `backgrounded_for_ms` — pre-bucketed
         *  strings group cleanly in Explore aggregations. */
        internal fun bgDurationBucket(ms: Long?): String = when {
            ms == null -> "unknown"
            ms < 60_000 -> "<1m"
            ms < 300_000 -> "1-5m"
            ms < 900_000 -> "5-15m"
            ms < 3_600_000 -> "15-60m"
            ms < 21_600_000 -> "1-6h"
            else -> ">6h"
        }

        /** Different range than [bgDurationBucket] because process uptime
         *  distributes differently. */
        internal fun uptimeBucket(ms: Long?): String = when {
            ms == null -> "unknown"
            ms < 10_000 -> "<10s"
            ms < 60_000 -> "10-60s"
            ms < 300_000 -> "1-5m"
            ms < 1_800_000 -> "5-30m"
            ms < 7_200_000 -> "30m-2h"
            else -> ">2h"
        }

        /** Null when the anchor is absent or later than the exit (a
         *  current-run stamp raced the read). */
        private fun durationTo(exitTimestampMs: Long, anchorMs: Long?): Long? {
            if (anchorMs == null || anchorMs <= 0 || anchorMs > exitTimestampMs) return null
            return exitTimestampMs - anchorMs
        }

        /**
         * Time in background at the moment of exit: the last transition
         * before the exit was a background. Comparing both stamps against the
         * exit timestamp (instead of clearing `backgrounded_at` on
         * foreground) keeps the answer correct however late the collection
         * runs — the common kill→relaunch flow foregrounds the app (stamping
         * `foregrounded_at` PAST the exit) before the FGS gets to collect.
         */
        internal fun backgroundedForMs(
            exitTimestampMs: Long,
            backgroundedAtMs: Long?,
            foregroundedAtMs: Long?,
        ): Long? {
            val sinceBackground = durationTo(exitTimestampMs, backgroundedAtMs) ?: return null
            if (foregroundedAtMs != null &&
                foregroundedAtMs > backgroundedAtMs!! &&
                foregroundedAtMs <= exitTimestampMs
            ) {
                return null
            }
            return sinceBackground
        }

        /**
         * `Sentry.metrics()` (not the FGS bridge) so one path serves both
         * processes: main-side Sentry is initialised by @sentry/react-native,
         * FGS-side by [SentryFgsBridge.init].
         */
        private fun capture(metric: ExitReasonMetric) {
            try {
                Sentry.metrics().count(
                    METRIC_NAME,
                    1.0,
                    null,
                    SentryMetricsParameters.create(metric.attributes),
                )
            } catch (t: Throwable) {
                Log.w(TAG, "exit-reason metric threw", t)
            }
        }

        private fun addRunBreadcrumb(procKey: String, count: Int) {
            try {
                Sentry.addBreadcrumb(
                    Breadcrumb().apply {
                        category = SentryCategories.EXIT
                        message = "reporting $count historical exit record(s)"
                        setData("proc", procKey)
                    },
                )
            } catch (t: Throwable) {
                Log.w(TAG, "exit-reason breadcrumb threw", t)
            }
        }
    }
}
