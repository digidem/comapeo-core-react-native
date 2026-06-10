package com.comapeo.core

import android.app.ActivityManager.RunningAppProcessInfo
import android.app.ApplicationExitInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * JVM unit tests for [ExitReasonsCollector.collect] — the filter/decode
 * pipeline, exercised with hand-built [ExitRecord]s and in-memory anchors
 * (the real `ApplicationExitInfo` can't be constructed off-device).
 */
class ExitReasonsCollectorTest {

    private val store = mutableMapOf<String, Long>()
    private val anchors = BackgroundAnchors(
        readLong = { store[it] },
        writeLong = { key, value -> store[key] = value },
    )
    private var now = 1_000_000_000_000L

    private fun collector(captureApplicationData: Boolean = true) =
        ExitReasonsCollector(anchors, captureApplicationData, nowMs = { now })

    private fun record(
        processName: String = MAIN_PROC_NAME,
        reason: Int = ApplicationExitInfo.REASON_SIGNALED,
        status: Int = 9,
        importance: Int = RunningAppProcessInfo.IMPORTANCE_FOREGROUND_SERVICE,
        timestampMs: Long = now - 60_000,
        pssKb: Long = 120_000,
        rssKb: Long = 150_000,
        description: String? = null,
    ) = ExitRecord(processName, reason, status, importance, timestampMs, pssKb, rssKb, description)

    private fun seedLastSeen(proc: String, value: Long = 0L) {
        anchors.writeLastSeenMs(proc, value)
    }

    // ── First run / high-water behaviour ───────────────────────────

    @Test
    fun firstRunInitialisesHighWaterAndEmitsNothing() {
        val metrics = collector().collect(MAIN_PROC_NAME, MAIN, listOf(record()))
        assertTrue("first observation must not report the pre-feature backlog", metrics.isEmpty())
        assertEquals(now, anchors.readLastSeenMs(MAIN))
    }

    @Test
    fun subsequentRunEmitsOnlyRecordsNewerThanHighWater() {
        seedLastSeen(MAIN, now - 100_000)
        val older = record(timestampMs = now - 200_000)
        val newer = record(timestampMs = now - 50_000)
        val metrics = collector().collect(MAIN_PROC_NAME, MAIN, listOf(older, newer))
        assertEquals(1, metrics.size)
        assertEquals(now - 50_000, metrics.single().attributes["exit_timestamp_ms"])
    }

    @Test
    fun highWaterAdvancesToMaxReportedTimestamp() {
        seedLastSeen(MAIN)
        collector().collect(
            MAIN_PROC_NAME,
            MAIN,
            listOf(record(timestampMs = now - 50_000), record(timestampMs = now - 10_000)),
        )
        assertEquals(now - 10_000, anchors.readLastSeenMs(MAIN))
    }

    @Test
    fun highWaterUnchangedWhenNothingKept() {
        seedLastSeen(MAIN, now - 5_000)
        collector().collect(MAIN_PROC_NAME, MAIN, listOf(record(timestampMs = now - 10_000)))
        assertEquals(now - 5_000, anchors.readLastSeenMs(MAIN))
    }

    @Test
    fun recordsForOtherProcessNamesAreFiltered() {
        seedLastSeen(MAIN)
        val metrics = collector().collect(
            MAIN_PROC_NAME,
            MAIN,
            listOf(record(processName = FGS_PROC_NAME)),
        )
        assertTrue(metrics.isEmpty())
    }

    // ── Attribute mapping ──────────────────────────────────────────

    @Test
    fun decodedMetricCarriesExpectedAttributes() {
        seedLastSeen(MAIN)
        val attrs = collector().collect(
            MAIN_PROC_NAME,
            MAIN,
            listOf(record(description = "OneUI: killed by frzInfo")),
        ).single().attributes

        assertEquals("main", attrs[SentryTags.PROC])
        assertEquals("signaled", attrs[SentryTags.EXIT_REASON])
        assertEquals("foreground_service", attrs[SentryTags.EXIT_PROCESS_STATE])
        assertEquals("9", attrs[SentryTags.EXIT_SIGNAL])
        assertEquals(false, attrs[SentryTags.EXIT_INTENTIONAL])
        assertEquals(true, attrs[SentryTags.OEM_KILLER_SUSPECTED])
        assertEquals("error", attrs[SentryTags.EXIT_SEVERITY])
        assertEquals("OneUI: killed by frzInfo", attrs["description"])
        assertEquals(120_000L, attrs["pss_kb"])
        assertEquals(150_000L, attrs["rss_kb"])
    }

    @Test
    fun signalAttributeOnlyPresentForSignaledReason() {
        seedLastSeen(MAIN)
        val attrs = collector().collect(
            MAIN_PROC_NAME,
            MAIN,
            listOf(record(reason = ApplicationExitInfo.REASON_LOW_MEMORY, status = 0)),
        ).single().attributes
        assertNull(attrs[SentryTags.EXIT_SIGNAL])
        assertEquals("low_memory", attrs[SentryTags.EXIT_REASON])
        assertEquals("error", attrs[SentryTags.EXIT_SEVERITY])
    }

    @Test
    fun intentionalExitIsInfoRegardlessOfProcessState() {
        seedLastSeen(MAIN)
        val attrs = collector().collect(
            MAIN_PROC_NAME,
            MAIN,
            listOf(
                record(
                    reason = ApplicationExitInfo.REASON_USER_STOPPED,
                    importance = RunningAppProcessInfo.IMPORTANCE_FOREGROUND,
                ),
            ),
        ).single().attributes
        assertEquals(true, attrs[SentryTags.EXIT_INTENTIONAL])
        assertEquals("info", attrs[SentryTags.EXIT_SEVERITY])
        assertEquals(false, attrs[SentryTags.OEM_KILLER_SUSPECTED])
    }

    @Test
    fun unknownReasonProducesSliceableAttribute() {
        seedLastSeen(MAIN)
        val attrs = collector().collect(
            MAIN_PROC_NAME,
            MAIN,
            listOf(record(reason = 42, status = 0)),
        ).single().attributes
        assertEquals("unknown:42", attrs[SentryTags.EXIT_REASON])
        assertEquals("info", attrs[SentryTags.EXIT_SEVERITY])
    }

    // ── Derived durations & anchors ────────────────────────────────

    @Test
    fun derivedFieldsNullSafeWhenAnchorsAbsent() {
        seedLastSeen(MAIN)
        val attrs = collector().collect(MAIN_PROC_NAME, MAIN, listOf(record())).single().attributes
        assertEquals("unknown", attrs[SentryTags.UPTIME_BUCKET])
        assertEquals("unknown", attrs[SentryTags.BG_DURATION_BUCKET])
        assertFalse(attrs.containsKey("alive_for_ms"))
        assertFalse(attrs.containsKey("backgrounded_for_ms"))
    }

    @Test
    fun clearedBackgroundAnchorYieldsUnknownBucket() {
        seedLastSeen(MAIN)
        anchors.writeBackgroundedAtMs(MAIN, 0L)
        val attrs = collector().collect(MAIN_PROC_NAME, MAIN, listOf(record())).single().attributes
        assertEquals("unknown", attrs[SentryTags.BG_DURATION_BUCKET])
    }

    @Test
    fun anchorNewerThanExitYieldsUnknownBucket() {
        // A current-run stamp that raced the read must not produce a negative duration.
        seedLastSeen(MAIN)
        val exitAt = now - 60_000
        anchors.writeProcessStartedAtMs(MAIN, exitAt + 5_000)
        val attrs = collector().collect(
            MAIN_PROC_NAME,
            MAIN,
            listOf(record(timestampMs = exitAt)),
        ).single().attributes
        assertEquals("unknown", attrs[SentryTags.UPTIME_BUCKET])
        assertFalse(attrs.containsKey("alive_for_ms"))
    }

    @Test
    fun durationsDeriveFromAnchors() {
        seedLastSeen(MAIN)
        val exitAt = now - 60_000
        anchors.writeProcessStartedAtMs(MAIN, exitAt - 120_000) // alive 2m
        anchors.writeBackgroundedAtMs(MAIN, exitAt - 600_000) // backgrounded 10m
        val attrs = collector().collect(
            MAIN_PROC_NAME,
            MAIN,
            listOf(record(timestampMs = exitAt)),
        ).single().attributes
        assertEquals(120_000L, attrs["alive_for_ms"])
        assertEquals(600_000L, attrs["backgrounded_for_ms"])
        assertEquals("1-5m", attrs[SentryTags.UPTIME_BUCKET])
        assertEquals("5-15m", attrs[SentryTags.BG_DURATION_BUCKET])
    }

    @Test
    fun fgsKilledInBackgroundDerivesFromMainAnchor() {
        seedLastSeen(FGS)
        val exitAt = now - 60_000
        anchors.writeBackgroundedAtMs(MAIN, exitAt - 300_000)
        val killed = collector().collect(
            FGS_PROC_NAME,
            FGS,
            listOf(record(processName = FGS_PROC_NAME, timestampMs = exitAt)),
        ).single().attributes
        assertEquals(true, killed[SentryTags.FGS_KILLED_IN_BACKGROUND])
        assertEquals("fgs", killed[SentryTags.PROC])
        // FGS metrics never carry the exact backgrounded_for_ms.
        assertFalse(killed.containsKey("backgrounded_for_ms"))

        // Cleared anchor (app was foregrounded) → false.
        seedLastSeen(FGS)
        anchors.writeBackgroundedAtMs(MAIN, 0L)
        val foreground = collector().collect(
            FGS_PROC_NAME,
            FGS,
            listOf(record(processName = FGS_PROC_NAME, timestampMs = exitAt)),
        ).single().attributes
        assertEquals(false, foreground[SentryTags.FGS_KILLED_IN_BACKGROUND])
    }

    @Test
    fun mainMetricsNeverCarryFgsKilledInBackground() {
        seedLastSeen(MAIN)
        anchors.writeBackgroundedAtMs(MAIN, now - 600_000)
        val attrs = collector().collect(MAIN_PROC_NAME, MAIN, listOf(record())).single().attributes
        assertNull(attrs[SentryTags.FGS_KILLED_IN_BACKGROUND])
    }

    // ── Privacy tiers ──────────────────────────────────────────────
    //
    // Coarse buckets are aggregate-resolution data and flow at the
    // diagnostic tier; exact millisecond durations are usage-shape data
    // and only flow when capture-application-data is on.

    @Test
    fun diagnosticTierKeepsBucketsButOmitsExactDurations() {
        seedLastSeen(FGS)
        val exitAt = now - 60_000
        anchors.writeProcessStartedAtMs(FGS, exitAt - 120_000)
        anchors.writeBackgroundedAtMs(MAIN, exitAt - 600_000)
        val attrs = collector(captureApplicationData = false)
            .collect(FGS_PROC_NAME, FGS, listOf(record(processName = FGS_PROC_NAME, timestampMs = exitAt)))
            .single().attributes
        assertEquals("1-5m", attrs[SentryTags.UPTIME_BUCKET])
        assertEquals("5-15m", attrs[SentryTags.BG_DURATION_BUCKET])
        assertEquals(true, attrs[SentryTags.FGS_KILLED_IN_BACKGROUND])
        assertFalse(attrs.containsKey("alive_for_ms"))
        assertFalse(attrs.containsKey("backgrounded_for_ms"))
    }

    @Test
    fun usageTierAddsExactDurations() {
        seedLastSeen(MAIN)
        val exitAt = now - 60_000
        anchors.writeProcessStartedAtMs(MAIN, exitAt - 120_000)
        val attrs = collector(captureApplicationData = true)
            .collect(MAIN_PROC_NAME, MAIN, listOf(record(timestampMs = exitAt)))
            .single().attributes
        assertEquals(120_000L, attrs["alive_for_ms"])
    }

    // ── Bucket boundaries ──────────────────────────────────────────

    @Test
    fun bgDurationBucketBoundaries() {
        val cases = mapOf(
            null to "unknown",
            0L to "<1m",
            59_999L to "<1m",
            60_000L to "1-5m",
            60_001L to "1-5m",
            299_999L to "1-5m",
            300_000L to "5-15m",
            300_001L to "5-15m",
            899_999L to "5-15m",
            900_000L to "15-60m",
            900_001L to "15-60m",
            3_599_999L to "15-60m",
            3_600_000L to "1-6h",
            3_600_001L to "1-6h",
            21_599_999L to "1-6h",
            21_600_000L to ">6h",
            21_600_001L to ">6h",
        )
        for ((ms, bucket) in cases) {
            assertEquals("bg($ms)", bucket, ExitReasonsCollector.bgDurationBucket(ms))
        }
    }

    @Test
    fun uptimeBucketBoundaries() {
        val cases = mapOf(
            null to "unknown",
            0L to "<10s",
            9_999L to "<10s",
            10_000L to "10-60s",
            10_001L to "10-60s",
            59_999L to "10-60s",
            60_000L to "1-5m",
            60_001L to "1-5m",
            299_999L to "1-5m",
            300_000L to "5-30m",
            300_001L to "5-30m",
            1_799_999L to "5-30m",
            1_800_000L to "30m-2h",
            1_800_001L to "30m-2h",
            7_199_999L to "30m-2h",
            7_200_000L to ">2h",
            7_200_001L to ">2h",
        )
        for ((ms, bucket) in cases) {
            assertEquals("uptime($ms)", bucket, ExitReasonsCollector.uptimeBucket(ms))
        }
    }

    private companion object {
        const val MAIN = SentryTags.PROC_MAIN
        const val FGS = SentryTags.PROC_FGS
        const val MAIN_PROC_NAME = "com.example.app"
        const val FGS_PROC_NAME = "com.example.app:ComapeoCore"
    }
}
