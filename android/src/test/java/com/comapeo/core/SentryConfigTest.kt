package com.comapeo.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * JVM-only unit tests for [SentryConfig.load]. Uses the pure
 * string-getter overload so we don't depend on a real `Bundle`
 * (the JVM unit-test classpath ships an `android.jar` stub where
 * every method throws "not mocked"). Same testing pattern as
 * [ControlFrameTest].
 *
 * Coverage rationale: this is the deserialization seam between the
 * Expo plugin's manifest writes and the native consumers (SDK init,
 * argv flags). A regression here would silently disable Sentry or
 * ship the wrong environment tag — both of which produce useless
 * Sentry projects rather than visible failures.
 */
class SentryConfigTest {

    private val DEFAULT_RELEASE: () -> String = { "1.2.3+42" }

    private fun mapGetter(map: Map<String, String?>): (String) -> String? =
        { key -> map[key] }

    @Test
    fun returnsNullWhenDsnMissing() {
        // Mirrors the "plugin not registered, or registered without a
        // sentry argument" case: no meta-data was written, so loading
        // produces null — the documented "Sentry off" state.
        val config = SentryConfig.load(mapGetter(emptyMap()), DEFAULT_RELEASE)
        assertNull(config)
    }

    @Test
    fun loadsRequiredFields() {
        val config = SentryConfig.load(
            mapGetter(
                mapOf(
                    SentryConfig.META_DSN to "https://abc@sentry.example/1",
                    SentryConfig.META_ENVIRONMENT to "production",
                ),
            ),
            DEFAULT_RELEASE,
        )!!
        assertEquals("https://abc@sentry.example/1", config.dsn)
        assertEquals("production", config.environment)
        assertEquals("1.2.3+42", config.release)
        assertNull(config.sampleRate)
        assertNull(config.tracesSampleRate)
        assertNull(config.rpcArgsBytes)
        assertNull(config.captureApplicationDataDefault)
        assertNull(config.enableLogs)
    }

    @Test
    fun pluginReleaseOverridesDefault() {
        // When the consumer passes `release` to the plugin, that
        // value wins over versionName+versionCode. Used to embed git
        // SHAs from EAS_BUILD_GIT_COMMIT_HASH (plan §4.1).
        val config = SentryConfig.load(
            mapGetter(
                mapOf(
                    SentryConfig.META_DSN to "https://x@sentry.io/1",
                    SentryConfig.META_ENVIRONMENT to "qa",
                    SentryConfig.META_RELEASE to "deadbeef",
                ),
            ),
            DEFAULT_RELEASE,
        )!!
        assertEquals("deadbeef", config.release)
    }

    @Test
    fun parsesNumericFields() {
        val config = SentryConfig.load(
            mapGetter(
                mapOf(
                    SentryConfig.META_DSN to "https://x@sentry.io/1",
                    SentryConfig.META_ENVIRONMENT to "production",
                    SentryConfig.META_SAMPLE_RATE to "0.5",
                    SentryConfig.META_TRACES_SAMPLE_RATE to "0.1",
                    SentryConfig.META_RPC_ARGS_BYTES to "0",
                ),
            ),
            DEFAULT_RELEASE,
        )!!
        assertEquals(0.5, config.sampleRate!!, 0.0)
        assertEquals(0.1, config.tracesSampleRate!!, 0.0)
        assertEquals(0, config.rpcArgsBytes!!.toInt())
    }

    @Test
    fun unparseableNumericFieldsAreNull() {
        // The plugin coerces values to strings on the way in; if a
        // future plugin bug or a hand-edited manifest produces an
        // unparseable value, we'd rather drop the field than crash.
        val config = SentryConfig.load(
            mapGetter(
                mapOf(
                    SentryConfig.META_DSN to "https://x@sentry.io/1",
                    SentryConfig.META_ENVIRONMENT to "production",
                    SentryConfig.META_SAMPLE_RATE to "not-a-number",
                    SentryConfig.META_RPC_ARGS_BYTES to "1.5",
                ),
            ),
            DEFAULT_RELEASE,
        )!!
        assertNull(config.sampleRate)
        assertNull(config.rpcArgsBytes)
    }

    @Test
    fun captureApplicationDataDefaultParses() {
        val on = SentryConfig.load(
            mapGetter(
                mapOf(
                    SentryConfig.META_DSN to "https://x@sentry.io/1",
                    SentryConfig.META_ENVIRONMENT to "qa",
                    SentryConfig.META_CAPTURE_APPLICATION_DATA_DEFAULT to "true",
                ),
            ),
            DEFAULT_RELEASE,
        )!!
        assertEquals(true, on.captureApplicationDataDefault)

        val off = SentryConfig.load(
            mapGetter(
                mapOf(
                    SentryConfig.META_DSN to "https://x@sentry.io/1",
                    SentryConfig.META_ENVIRONMENT to "production",
                    SentryConfig.META_CAPTURE_APPLICATION_DATA_DEFAULT to "false",
                ),
            ),
            DEFAULT_RELEASE,
        )!!
        assertEquals(false, off.captureApplicationDataDefault)
    }

    @Test
    fun captureApplicationDataDefaultStrictness() {
        // `toBooleanStrictOrNull` rejects values other than "true" /
        // "false". Defensive: a stray "1"/"yes" from a hand-written
        // manifest should not silently flip the default. Returns
        // null → native treats absence as `false`.
        val config = SentryConfig.load(
            mapGetter(
                mapOf(
                    SentryConfig.META_DSN to "https://x@sentry.io/1",
                    SentryConfig.META_ENVIRONMENT to "qa",
                    SentryConfig.META_CAPTURE_APPLICATION_DATA_DEFAULT to "yes",
                ),
            ),
            DEFAULT_RELEASE,
        )!!
        assertNull(config.captureApplicationDataDefault)
    }

    @Test
    fun enableLogsParses() {
        val on = SentryConfig.load(
            mapGetter(
                mapOf(
                    SentryConfig.META_DSN to "https://x@sentry.io/1",
                    SentryConfig.META_ENVIRONMENT to "qa",
                    SentryConfig.META_ENABLE_LOGS to "true",
                ),
            ),
            DEFAULT_RELEASE,
        )!!
        assertEquals(true, on.enableLogs)

        val off = SentryConfig.load(
            mapGetter(
                mapOf(
                    SentryConfig.META_DSN to "https://x@sentry.io/1",
                    SentryConfig.META_ENVIRONMENT to "qa",
                    SentryConfig.META_ENABLE_LOGS to "false",
                ),
            ),
            DEFAULT_RELEASE,
        )!!
        assertEquals(false, off.enableLogs)

        // Stray value rejected; native treats null as off.
        val stray = SentryConfig.load(
            mapGetter(
                mapOf(
                    SentryConfig.META_DSN to "https://x@sentry.io/1",
                    SentryConfig.META_ENVIRONMENT to "qa",
                    SentryConfig.META_ENABLE_LOGS to "yes",
                ),
            ),
            DEFAULT_RELEASE,
        )!!
        assertNull(stray.enableLogs)
    }

    @Test
    fun missingEnvironmentReturnsNullNotThrow() {
        // The plugin refuses to prebuild without environment (§4.1),
        // but a stale prebuild from before that validation was added
        // would still ship. The original "throw" behaviour crashed
        // every cold start with no way to recover. Now we log loud
        // and return null (Sentry off) so the host app keeps
        // running; the misconfiguration becomes visible the next
        // time someone re-runs `expo prebuild`.
        val config = SentryConfig.load(
            mapGetter(mapOf(SentryConfig.META_DSN to "https://x@sentry.io/1")),
            DEFAULT_RELEASE,
        )
        assertNull(
            "DSN-without-environment should disable Sentry rather than crash",
            config,
        )
    }
}
