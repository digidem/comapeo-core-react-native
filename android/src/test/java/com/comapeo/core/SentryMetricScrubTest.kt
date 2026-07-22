package com.comapeo.core

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mirror of the `isForbiddenMetric` cases in `src/__tests__/sentry-scrub.test.js`
 *  and `backend/lib/before-send.test.mjs` — the list is hand-mirrored across
 *  the four layers, so the assertions are too. */
class SentryMetricScrubTest {

    @Test
    fun forbiddenMetricNameIsRejected() {
        assertTrue(SentryMetricScrub.isForbiddenMetric("device.model", emptyMap()))
    }

    @Test
    fun forbiddenAttributeNameIsRejected() {
        assertTrue(
            SentryMetricScrub.isForbiddenMetric(
                "comapeo.app.exit",
                mapOf("project_id" to "abc123"),
            ),
        )
        assertTrue(
            SentryMetricScrub.isForbiddenMetric(
                "comapeo.app.exit",
                mapOf("locale" to "es_PE"),
            ),
        )
    }

    @Test
    fun coordinateShapedAttributeValueIsRejected() {
        assertTrue(
            SentryMetricScrub.isForbiddenMetric(
                "comapeo.app.exit",
                mapOf("note" to "lat=-12.05, lng=-77.03"),
            ),
        )
    }

    @Test
    fun ordinaryExitMetricAttributesPass() {
        assertFalse(
            SentryMetricScrub.isForbiddenMetric(
                ExitReasonsCollector.METRIC_NAME,
                mapOf(
                    SentryTags.EXIT_REASON to "anr",
                    SentryTags.EXIT_PROCESS_STATE to "foreground",
                    SentryTags.EXIT_SEVERITY to "error",
                    SentryTags.EXIT_INTENTIONAL to "false",
                    SentryTags.OEM_KILLER_SUSPECTED to "false",
                    SentryTags.UPTIME_BUCKET to "1h-6h",
                ),
            ),
        )
    }
}
