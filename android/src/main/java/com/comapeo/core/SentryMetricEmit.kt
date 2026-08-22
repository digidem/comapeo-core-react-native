package com.comapeo.core

import android.content.Context
import android.util.Log
import io.sentry.Sentry
import io.sentry.metrics.SentryMetricsParameters

/**
 * The one path native metrics take to `Sentry.metrics()`: injects the shared
 * `platform` / `device_class` / `os_major` attributes and runs
 * [SentryMetricScrub], so a call site can forget neither. Call-site
 * attributes win on a key collision. Rationale in `docs/sentry-integration.md`.
 */
internal object SentryMetricEmit {
    @Volatile
    private var deviceAttributes: Map<String, String> = emptyMap()

    /** Idempotent; call from any entry point that has a `Context` before
     *  emitting. Never throws — attribution degrades to no device attributes. */
    fun ensureDeviceAttributes(context: Context) {
        if (deviceAttributes.isNotEmpty()) return
        deviceAttributes = try {
            DeviceTags.compute(context).asMetricAttributes()
        } catch (t: Throwable) {
            Log.w(TAG, "DeviceTags.compute threw; emitting metrics unattributed", t)
            emptyMap()
        }
    }

    fun count(name: String, attributes: Map<String, Any>) {
        emit(name, attributes) { params ->
            Sentry.metrics().count(name, 1.0, null, params)
        }
    }

    fun distribution(name: String, value: Double, unit: String, attributes: Map<String, Any>) {
        emit(name, attributes) { params ->
            Sentry.metrics().distribution(name, value, unit, params)
        }
    }

    private inline fun emit(
        name: String,
        attributes: Map<String, Any>,
        block: (SentryMetricsParameters) -> Unit,
    ) {
        try {
            val merged = deviceAttributes + attributes
            // Silently drop a metric carrying a forbidden name/attribute — an
            // expected, innocuous gate that isn't worth a log line.
            if (SentryMetricScrub.isForbiddenMetric(name, merged)) return
            block(SentryMetricsParameters.create(merged))
        } catch (t: Throwable) {
            Log.w(TAG, "metric $name threw", t)
        }
    }

    @JvmStatic
    internal fun setDeviceAttributesForTests(attributes: Map<String, String>) {
        deviceAttributes = attributes
    }

    @JvmStatic
    internal fun resetForTests() {
        deviceAttributes = emptyMap()
    }

    private const val TAG = "ComapeoCore.Sentry"
}
