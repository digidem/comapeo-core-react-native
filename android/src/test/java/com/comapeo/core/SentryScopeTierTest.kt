package com.comapeo.core

import io.sentry.Hint
import io.sentry.SentryEvent
import io.sentry.SentryLevel
import io.sentry.SpanId
import io.sentry.SpanStatus
import io.sentry.protocol.App
import io.sentry.protocol.Device
import io.sentry.protocol.OperatingSystem
import io.sentry.protocol.SentryId
import io.sentry.protocol.SentrySpan
import io.sentry.protocol.SentryTransaction
import io.sentry.protocol.TransactionInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.TimeZone

/**
 * Pure-function tests for [TierScopeEventProcessor] — the per-tier field
 * split from docs/sentry-integration-plan.md §9b.3 and the boot-transaction
 * slimming from §9b.4.
 */
class SentryScopeTierTest {

    private val diagnostic = TierScopeEventProcessor(applicationUsageData = false)
    private val usage = TierScopeEventProcessor(applicationUsageData = true)

    // ── Device context ──────────────────────────────────────────────

    private fun fullDevice() = Device().apply {
        manufacturer = "Google"
        brand = "google"
        model = "Pixel 7a"
        modelId = "lynx"
        family = "Android"
        archs = arrayOf("arm64-v8a")
        isSimulator = false
        processorCount = 8
        memorySize = 8_000_000_000L
        // What a "128 GB" phone actually reports after formatting.
        storageSize = 119L * (1L shl 30)
        // Fingerprint-friendly extras that must not ship at diagnostic.
        name = "Maria's Pixel"
        id = "abcdef0123456789"
        screenWidthPixels = 1080
        screenHeightPixels = 2400
        screenDensity = 2.6f
        screenDpi = 420
        timezone = TimeZone.getTimeZone("America/Lima")
        freeMemory = 123_456_789L
        connectionType = "wifi"
        batteryLevel = 42f
    }

    @Test
    fun diagnosticKeepsCoarseDeviceIdentity() {
        val event = SentryEvent().apply { contexts.setDevice(fullDevice()) }
        val device = diagnostic.process(event, Hint())!!.contexts.device!!
        assertEquals("Google", device.manufacturer)
        assertEquals("google", device.brand)
        assertEquals("Pixel 7a", device.model)
        assertEquals("lynx", device.modelId)
        assertEquals("Android", device.family)
        assertEquals(false, device.isSimulator)
        assertEquals(8, device.processorCount)
        assertEquals(8_000_000_000L, device.memorySize)
    }

    @Test
    fun diagnosticDropsFingerprintFriendlyDeviceFields() {
        val event = SentryEvent().apply { contexts.setDevice(fullDevice()) }
        val device = diagnostic.process(event, Hint())!!.contexts.device!!
        assertNull(device.name)
        assertNull(device.id)
        assertNull(device.screenWidthPixels)
        assertNull(device.screenHeightPixels)
        assertNull(device.screenDensity)
        assertNull(device.screenDpi)
        assertNull(device.timezone)
        assertNull(device.freeMemory)
        assertNull(device.connectionType)
        assertNull(device.batteryLevel)
    }

    @Test
    fun usageTierAddsScreenMetricsAndTimezoneBack() {
        val event = SentryEvent().apply { contexts.setDevice(fullDevice()) }
        val device = usage.process(event, Hint())!!.contexts.device!!
        assertEquals(1080, device.screenWidthPixels)
        assertEquals(2400, device.screenHeightPixels)
        assertEquals(2.6f, device.screenDensity)
        assertEquals(420, device.screenDpi)
        assertNotNull(device.timezone)
        // Not in the usage-tier add-back list — dropped at both tiers.
        assertNull(device.name)
        assertNull(device.id)
        assertNull(device.freeMemory)
    }

    @Test
    fun storageSizeIsBucketedToStandardSizesAtBothTiers() {
        for (processor in listOf(diagnostic, usage)) {
            val event = SentryEvent().apply { contexts.setDevice(fullDevice()) }
            val device = processor.process(event, Hint())!!.contexts.device!!
            assertEquals(128L * (1L shl 30), device.storageSize)
        }
    }

    @Test
    fun bucketStorageSizeRoundsUpToStandardSizes() {
        val gb = 1L shl 30
        // Buckets start at 8 GB — 8/16 GB devices are still in the field.
        assertEquals(8 * gb, TierScopeEventProcessor.bucketStorageSize(1))
        assertEquals(8 * gb, TierScopeEventProcessor.bucketStorageSize(8 * gb))
        assertEquals(16 * gb, TierScopeEventProcessor.bucketStorageSize(8 * gb + 1))
        assertEquals(32 * gb, TierScopeEventProcessor.bucketStorageSize(32 * gb))
        assertEquals(64 * gb, TierScopeEventProcessor.bucketStorageSize(32 * gb + 1))
        assertEquals(256 * gb, TierScopeEventProcessor.bucketStorageSize(238 * gb))
        assertEquals(1024 * gb, TierScopeEventProcessor.bucketStorageSize(4096 * gb))
    }

    // ── Errors keep the full native scope ───────────────────────────

    @Test
    fun errorsKeepFullDeviceScopeButDropCultureAtDiagnostic() {
        val event = SentryEvent().apply {
            level = SentryLevel.ERROR
            contexts.setDevice(fullDevice())
            contexts.setOperatingSystem(fullOs())
            contexts.setApp(fullApp())
            contexts.put("culture", mapOf("locale" to "es_PE"))
        }
        val processed = diagnostic.process(event, Hint())!!
        // Fingerprint-friendly device/os/app fields survive on an error.
        val device = processed.contexts.device!!
        assertEquals("Maria's Pixel", device.name)
        assertEquals(1080, device.screenWidthPixels)
        assertNotNull(device.timezone)
        // Storage stays exact (not bucketed) — full detail for debugging.
        assertEquals(119L * (1L shl 30), device.storageSize)
        assertEquals("5.15.104-android13-9-abc", processed.contexts.operatingSystem!!.kernelVersion)
        assertEquals("CoMapeo", processed.contexts.app!!.appName)
        // Culture still dropped — no debugging value.
        assertNull(processed.contexts.get("culture"))
    }

    @Test
    fun errorsKeepCultureAtUsageTier() {
        val event = SentryEvent().apply {
            level = SentryLevel.FATAL
            contexts.put("culture", mapOf("locale" to "es_PE"))
        }
        assertNotNull(usage.process(event, Hint())!!.contexts.get("culture"))
    }

    // ── OS context ──────────────────────────────────────────────────

    private fun fullOs() = OperatingSystem().apply {
        name = "Android"
        version = "14"
        kernelVersion = "5.15.104-android13-9-abc"
        build = "UQ1A.240205.004"
        isRooted = false
    }

    @Test
    fun diagnosticKeepsOsNameAndVersionOnly() {
        val event = SentryEvent().apply { contexts.setOperatingSystem(fullOs()) }
        val os = diagnostic.process(event, Hint())!!.contexts.operatingSystem!!
        assertEquals("Android", os.name)
        assertEquals("14", os.version)
        assertNull(os.kernelVersion)
        assertNull(os.build)
        assertNull(os.isRooted)
    }

    @Test
    fun usageTierAddsKernelAndBuildBack() {
        val event = SentryEvent().apply { contexts.setOperatingSystem(fullOs()) }
        val os = usage.process(event, Hint())!!.contexts.operatingSystem!!
        assertEquals("5.15.104-android13-9-abc", os.kernelVersion)
        assertEquals("UQ1A.240205.004", os.build)
    }

    // ── App context ─────────────────────────────────────────────────

    private fun fullApp() = App().apply {
        appIdentifier = "com.comapeo.app"
        appVersion = "1.2.3"
        appBuild = "456"
        appName = "CoMapeo"
        deviceAppHash = "deadbeef"
        inForeground = true
    }

    @Test
    fun diagnosticKeepsAppIdVersionBuildOnly() {
        val event = SentryEvent().apply { contexts.setApp(fullApp()) }
        val app = diagnostic.process(event, Hint())!!.contexts.app!!
        assertEquals("com.comapeo.app", app.appIdentifier)
        assertEquals("1.2.3", app.appVersion)
        assertEquals("456", app.appBuild)
        assertNull(app.appName)
        assertNull(app.deviceAppHash)
        assertNull(app.inForeground)
    }

    @Test
    fun usageTierAddsAppNameBackButNotDeviceAppHash() {
        val event = SentryEvent().apply { contexts.setApp(fullApp()) }
        val app = usage.process(event, Hint())!!.contexts.app!!
        assertEquals("CoMapeo", app.appName)
        assertNull(app.deviceAppHash)
        assertNull(app.inForeground)
    }

    // ── Culture context ─────────────────────────────────────────────

    @Test
    fun diagnosticDropsCultureEntirely() {
        val event = SentryEvent()
        event.contexts.put("culture", mapOf("locale" to "es_PE", "timezone" to "America/Lima"))
        assertNull(diagnostic.process(event, Hint())!!.contexts.get("culture"))
    }

    @Test
    fun usageTierKeepsCulture() {
        val event = SentryEvent()
        event.contexts.put("culture", mapOf("locale" to "es_PE"))
        assertNotNull(usage.process(event, Hint())!!.contexts.get("culture"))
    }

    // ── Boot transaction slimming (§9b.4) ───────────────────────────

    private fun bootTransaction(): SentryTransaction {
        val span = SentrySpan(
            /* startTimestamp = */ 0.0,
            /* timestamp = */ 1.0,
            /* traceId = */ SentryId(),
            /* spanId = */ SpanId(),
            /* parentSpanId = */ null,
            /* op = */ "boot.rootkey-load",
            /* description = */ "boot.rootkey-load",
            /* status = */ SpanStatus.OK,
            /* origin = */ null,
            /* tags = */ emptyMap(),
            /* measurements = */ emptyMap(),
            /* data = */ mutableMapOf("generated" to true),
        )
        return SentryTransaction(
            /* transaction = */ "comapeo.boot",
            /* startTimestamp = */ 0.0,
            /* timestamp = */ 2.0,
            /* spans = */ listOf(span),
            /* measurements = */ emptyMap(),
            /* transactionInfo = */ TransactionInfo("custom"),
        ).apply {
            setTag(SentryTags.PROC, SentryTags.PROC_FGS)
            setTag(SentryTags.LAYER, SentryTags.LAYER_NATIVE)
            setTag(SentryTags.BOOT_KIND, SentryTags.BOOT_KIND_USER_FOREGROUND)
        }
    }

    @Test
    fun diagnosticSlimsBootTransactionToPhaseTimings() {
        val tx = diagnostic.process(bootTransaction(), Hint())!!
        assertNull("boot.kind is a foreground-state tag", tx.getTag(SentryTags.BOOT_KIND))
        assertEquals(SentryTags.PROC_FGS, tx.getTag(SentryTags.PROC))
        val span = tx.spans.single()
        assertTrue("span data must be stripped", span.data.isNullOrEmpty())
        // Timings and the bare phase name survive.
        assertEquals("boot.rootkey-load", span.op)
        assertEquals(span.op, span.description)
        assertEquals(0.0, span.startTimestamp, 0.0)
        assertEquals(1.0, span.timestamp!!, 0.0)
    }

    @Test
    fun usageTierKeepsBootKindAndSpanData() {
        val tx = usage.process(bootTransaction(), Hint())!!
        assertEquals(SentryTags.BOOT_KIND_USER_FOREGROUND, tx.getTag(SentryTags.BOOT_KIND))
        assertEquals(true, tx.spans.single().data?.get("generated"))
    }

    @Test
    fun nonBootTransactionsKeepTheirSpanData() {
        val span = SentrySpan(
            0.0, 1.0, SentryId(), SpanId(), null,
            "rpc.server", "project.observation.create", SpanStatus.OK, null,
            emptyMap(), emptyMap(), mutableMapOf("rpc.system" to "comapeo-ipc"),
        )
        val tx = SentryTransaction(
            "project.observation.create", 0.0, 2.0, listOf(span),
            emptyMap(), TransactionInfo("custom"),
        )
        val processed = diagnostic.process(tx, Hint())!!
        assertEquals("comapeo-ipc", processed.spans.single().data?.get("rpc.system"))
    }
}
