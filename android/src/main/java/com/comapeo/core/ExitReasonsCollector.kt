package com.comapeo.core

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build
import android.util.Log
import androidx.annotation.RequiresApi
import io.sentry.Breadcrumb
import io.sentry.Sentry
import io.sentry.SentryEvent
import io.sentry.SentryLevel
import io.sentry.protocol.Message

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

/** Decoded Sentry emission for one exit record. */
internal data class ExitReasonEvent(
    val message: String,
    val level: String,
    val tags: Map<String, String>,
    val extras: Map<String, Any>,
)

/**
 * Surfaces `ActivityManager.getHistoricalProcessExitReasons()` records to
 * Sentry on the next process start. One event per record newer than the
 * per-process high-water timestamp; tag/level taxonomy in
 * `docs/sentry-integration.md`.
 *
 * Two callers — main process ([ComapeoCoreApplicationLifecycleListener]) and
 * the FGS process ([ComapeoCoreService]) — each reporting exits for its own
 * process name only, so Sentry never sees cross-process duplicates.
 *
 * The duration tags/extras derived from [BackgroundAnchors]
 * (`bg_duration_bucket`, `uptime_bucket`, `comapeo.fgs.killed_in_background`,
 * `alive_for_ms`, `backgrounded_for_ms`) are app-usage-tier data and only
 * flow when capture-application-data is on; the records themselves are
 * diagnostic-tier.
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
    fun collect(processName: String, procKey: String, records: List<ExitRecord>): List<ExitReasonEvent> {
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

    private fun decode(record: ExitRecord, procKey: String): ExitReasonEvent {
        val reasonTag = ExitReasonTags.decodeReason(record.reason)
        val tags = buildMap {
            put(SentryTags.PROC, procKey)
            put(SentryTags.EXIT_REASON, reasonTag)
            put(SentryTags.EXIT_PROCESS_STATE, ExitReasonTags.decodeImportance(record.importance))
            if (record.reason == ApplicationExitInfo.REASON_SIGNALED) {
                put(SentryTags.EXIT_SIGNAL, record.status.toString())
            }
            put(SentryTags.EXIT_INTENTIONAL, ExitReasonTags.isIntentional(record.reason).toString())
            put(
                SentryTags.OEM_KILLER_SUSPECTED,
                ExitReasonTags.isOemKillerSuspected(record.reason, record.importance, record.status)
                    .toString(),
            )
        }
        val extras = buildMap<String, Any> {
            record.description?.let { put("description", it) }
            put("pss_kb", record.pssKb)
            put("rss_kb", record.rssKb)
            put("exit_timestamp_ms", record.timestampMs)
        }
        if (!captureApplicationData) {
            return ExitReasonEvent(messageFor(reasonTag), ExitReasonTags.levelFor(record.reason), tags, extras)
        }

        val aliveForMs = durationTo(record.timestampMs, anchors.readProcessStartedAtMs(procKey))
        // The FGS has no foreground/background concept; both procs derive the
        // backgrounded-for cohort from the main process's anchor.
        val mainBackgroundedAt = anchors.readBackgroundedAtMs(SentryTags.PROC_MAIN)
        val backgroundedForMs = durationTo(record.timestampMs, mainBackgroundedAt)
        return ExitReasonEvent(
            message = messageFor(reasonTag),
            level = ExitReasonTags.levelFor(record.reason),
            tags = tags + buildMap {
                put(SentryTags.UPTIME_BUCKET, uptimeBucket(aliveForMs))
                put(SentryTags.BG_DURATION_BUCKET, bgDurationBucket(backgroundedForMs))
                if (procKey == SentryTags.PROC_FGS) {
                    put(
                        SentryTags.FGS_KILLED_IN_BACKGROUND,
                        (backgroundedForMs != null).toString(),
                    )
                }
            },
            extras = extras + buildMap {
                aliveForMs?.let { put("alive_for_ms", it) }
                if (procKey == SentryTags.PROC_MAIN) {
                    backgroundedForMs?.let { put("backgrounded_for_ms", it) }
                }
            },
        )
    }

    companion object {
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
                val events = ExitReasonsCollector(
                    anchors = BackgroundAnchors.open(context),
                    captureApplicationData = captureApplicationData,
                ).collect(processName, procKey, queryRecords(context))
                log("[${SentryCategories.EXIT}] $procKey: ${events.size} new exit record(s)")
                if (events.isEmpty()) return
                addRunBreadcrumb(procKey, events.size)
                events.forEach(::capture)
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
                        // exceed Sentry's event size limit and carry user-context
                        // strings on some vendors. `description` is a short label.
                        description = info.description,
                    )
                }
        }

        /** Stable message string so Sentry groups one issue per reason. */
        internal fun messageFor(reasonTag: String): String =
            "android exit: REASON_${reasonTag.uppercase()}"

        /** Coarse cohort axis for `backgrounded_for_ms` — string tags are
         *  reliably aggregable in Discover; numeric extras aren't. */
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
         * `Sentry.captureEvent` (not the FGS bridge) so one path serves both
         * processes: main-side Sentry is initialised by @sentry/react-native,
         * FGS-side by [SentryFgsBridge.init]; pre-init the SDK no-ops. Built
         * as an event (not `captureMessage`) so numeric extras keep their type.
         */
        private fun capture(event: ExitReasonEvent) {
            try {
                val sentryEvent = SentryEvent().apply {
                    message = Message().apply { formatted = event.message }
                    level = when (event.level) {
                        "error" -> SentryLevel.ERROR
                        "warning" -> SentryLevel.WARNING
                        else -> SentryLevel.INFO
                    }
                    event.tags.forEach { (k, v) -> setTag(k, v) }
                    event.extras.forEach { (k, v) -> setExtra(k, v) }
                }
                Sentry.captureEvent(sentryEvent)
            } catch (t: Throwable) {
                Log.w(TAG, "exit-reason capture threw", t)
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
