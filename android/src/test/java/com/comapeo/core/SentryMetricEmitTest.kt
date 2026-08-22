package com.comapeo.core

import io.sentry.Sentry
import io.sentry.SentryMetricsEvent
import io.sentry.SentryOptions
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * JVM unit tests for [SentryMetricEmit] — the one path native metrics take
 * to the SDK. Pins the device-attribute injection and the scrub so neither
 * can be dropped (or the merge flipped) without a test failing. Uses the
 * synchronous metrics `beforeSend` hook to observe what reaches the SDK.
 */
class SentryMetricEmitTest {

    private val recorded = mutableListOf<SentryMetricsEvent>()

    @After
    fun tearDown() {
        SentryMetricEmit.resetForTests()
        Sentry.close()
    }

    private fun initSentry() {
        recorded.clear()
        Sentry.init { options: SentryOptions ->
            options.dsn = "https://abc@sentry.io/1"
            options.environment = "test"
            options.release = "0.0.0+test"
            // Runs synchronously inside the client's captureMetric, so a
            // recorded metric proves the emission — no need to wait out the
            // metrics batch window.
            options.metrics.setBeforeSend { metric, _ ->
                recorded.add(metric)
                metric
            }
        }
        SentryMetricEmit.setDeviceAttributesForTests(DEVICE_ATTRS)
    }

    private fun attr(metric: SentryMetricsEvent, key: String): Any? =
        metric.attributes?.get(key)?.value

    @Test
    fun countCarriesTheDeviceAttributesAndTheCallSiteOnes() {
        initSentry()
        SentryMetricEmit.count("comapeo.app.exit", mapOf(SentryTags.EXIT_REASON to "anr"))
        val metric = recorded.single()
        assertEquals("comapeo.app.exit", metric.name)
        assertEquals("android", attr(metric, SentryTags.PLATFORM))
        assertEquals(DeviceTags.CLASS_LOW, attr(metric, SentryTags.DEVICE_CLASS))
        assertEquals("android.11", attr(metric, SentryTags.OS_MAJOR))
        assertEquals("anr", attr(metric, SentryTags.EXIT_REASON))
    }

    @Test
    fun callSiteAttributesWinOnAKeyCollision() {
        initSentry()
        SentryMetricEmit.count("comapeo.test", mapOf(SentryTags.OS_MAJOR to "android.99"))
        assertEquals("android.99", attr(recorded.single(), SentryTags.OS_MAJOR))
    }

    @Test
    fun distributionsCarryTheDeviceAttributesToo() {
        initSentry()
        SentryMetricEmit.distribution(
            "comapeo.app.exit.rss_bytes",
            150_000.0 * 1024,
            "byte",
            mapOf(SentryTags.PROC to SentryTags.PROC_FGS),
        )
        val metric = recorded.single()
        assertEquals(DeviceTags.CLASS_LOW, attr(metric, SentryTags.DEVICE_CLASS))
        assertEquals(SentryTags.PROC_FGS, attr(metric, SentryTags.PROC))
        assertEquals(150_000.0 * 1024, metric.value!!, 0.0)
    }

    @Test
    fun forbiddenAttributeNameDropsTheMetric() {
        initSentry()
        SentryMetricEmit.count("comapeo.test", mapOf("project_id" to "abc123"))
        assertTrue(recorded.isEmpty())
    }

    @Test
    fun forbiddenValuePatternDropsDistributionsToo() {
        // `description` is vendor free text; the coordinate gate must apply
        // on the distribution path exactly as on counts.
        initSentry()
        SentryMetricEmit.distribution(
            "comapeo.app.exit.rss_bytes",
            1.0,
            "byte",
            mapOf("description" to "killed at lat: -12.5"),
        )
        assertTrue(recorded.isEmpty())
    }

    @Test
    fun emitsUnattributedWhenDeviceAttributesAreUnavailable() {
        initSentry()
        SentryMetricEmit.resetForTests()
        SentryMetricEmit.count("comapeo.test", mapOf(SentryTags.EXIT_REASON to "anr"))
        val metric = recorded.single()
        assertEquals("anr", attr(metric, SentryTags.EXIT_REASON))
        assertEquals(null, attr(metric, SentryTags.DEVICE_CLASS))
    }

    private companion object {
        val DEVICE_ATTRS = DeviceTags(
            platform = "android",
            deviceClass = DeviceTags.CLASS_LOW,
            osMajor = "android.11",
        ).asMetricAttributes()
    }
}
