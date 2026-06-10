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
 * capture-application-data is on.
 */
internal class ExitReasonsCollector(
    private val anchors: BackgroundAnchors,
    private val captureApplicationData: Boolean,
    private val nowMs: () -> Long = System::currentTimeMillis,
) {
    /**
     * Filter + decode [records]; advances the high-water timestamp as a side
     * effect. First observation (no high-water key) initialises it to "now"
     * and emits nothing — reporting the pre-feature backlog on every device's
     * first update would flood Sentry with stale deaths.
     */
    fun collect(processName: String, procKey: String, records: List<ExitRecord>): List<ExitReasonMetric> {
        val lastSeen = anchors.readLastSeenMs(procKey)
        if (lastSeen == null) {
            anchors.writeLastSeenMs(procKey, nowMs())
            return emptyList()
        }
        val kept = records.filter { it.processName == processName && it.timestampMs > lastSeen }
        if (kept.isEmpty()) return emptyList()
        anchors.writeLastSeenMs(procKey, kept.maxOf { it.timestampMs })
        return kept.map { decode(it, procKey) }
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

            val aliveForMs = durationTo(record.timestampMs, anchors.readProcessStartedAtMs(procKey))
            // The FGS has no foreground/background concept; both procs derive
            // the backgrounded-for cohort from the main process's anchor.
            val backgroundedForMs =
                durationTo(record.timestampMs, anchors.readBackgroundedAtMs(SentryTags.PROC_MAIN))
            put(SentryTags.UPTIME_BUCKET, uptimeBucket(aliveForMs))
            put(SentryTags.BG_DURATION_BUCKET, bgDurationBucket(backgroundedForMs))
            if (procKey == SentryTags.PROC_FGS) {
                put(SentryTags.FGS_KILLED_IN_BACKGROUND, backgroundedForMs != null)
            }
            if (captureApplicationData) {
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

        /** Anything older than the last 10 cold starts isn't useful, and
         *  `maxNum=0` (unlimited) is documented as slow on some devices. */
        private const val MAX_RECORDS = 10

        /**
         * Production entry point. Query → decode → capture, plus the
         * high-water/anchor bookkeeping. Callers schedule this off the main
         * thread (prefs read + Sentry capture must not block process start)
         * and stamp `process_started_at` only AFTER this returns — the
         * decoder must see the previous session's anchor, not this run's.
         */
        @JvmStatic
        fun collectAndReport(
            context: Context,
            processName: String,
            procKey: String,
            captureApplicationData: Boolean,
        ) {
            if (Build.VERSION.SDK_INT < 30) {
                // One boot-time scope tag so dashboards can exclude pre-30
                // devices from death-rate math. No-op if Sentry isn't up yet.
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
                val metrics = ExitReasonsCollector(
                    anchors = BackgroundAnchors.open(context),
                    captureApplicationData = captureApplicationData,
                ).collect(processName, procKey, queryRecords(context))
                log("[${SentryCategories.EXIT}] $procKey: ${metrics.size} new exit record(s)")
                if (metrics.isEmpty()) return
                addRunBreadcrumb(procKey, metrics.size)
                metrics.forEach(::capture)
            } catch (t: Throwable) {
                // Observability is decorative; a thrown collector must never
                // take either process down.
                Log.w(TAG, "ExitReasonsCollector.collectAndReport threw", t)
            }
        }

        @RequiresApi(30)
        private fun queryRecords(context: Context): List<ExitRecord> {
            val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            return am.getHistoricalProcessExitReasons(context.packageName, 0, MAX_RECORDS)
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

        /** Null when the anchor is absent, cleared (`0`), or later than the
         *  exit (a current-run stamp raced the read). */
        private fun durationTo(exitTimestampMs: Long, anchorMs: Long?): Long? {
            if (anchorMs == null || anchorMs <= 0 || anchorMs > exitTimestampMs) return null
            return exitTimestampMs - anchorMs
        }

        /**
         * `Sentry.metrics()` (not the FGS bridge) so one path serves both
         * processes: main-side Sentry is initialised by @sentry/react-native,
         * FGS-side by [SentryFgsBridge.init]; pre-init the SDK no-ops.
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
