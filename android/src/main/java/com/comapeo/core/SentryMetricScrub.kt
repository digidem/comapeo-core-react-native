package com.comapeo.core

/**
 * Forbidden-name/value gate for metrics emitted through the native SDK,
 * mirroring the `isForbiddenMetric` check the JS/Node paths run.
 * Hand-mirrored from `src/sentry-scrub.ts` and `backend/before-send.js`
 * (three module systems, so no build-time copy is practical) — keep the
 * lists in lock-step; each file points at the others.
 */
internal object SentryMetricScrub {
    private val FORBIDDEN_METRIC_TAG_NAMES = setOf(
        "device.model",
        "device.id",
        "device.manufacturer",
        "os.version",
        "screen.resolution",
        "screen.density",
        "screen.dpi",
        "locale",
        "timezone",
        "project_id",
        "peer_id",
        "peer_count",
        "rootkey",
    )

    private val FORBIDDEN_METRIC_VALUE_PATTERNS = listOf(
        Regex(
            """\b(?:latitude|longitude|lat|lng|lon)\b\s*["']?\s*[:=]\s*-?\d+(?:\.\d+)?""",
            RegexOption.IGNORE_CASE,
        ),
    )

    /**
     * `true` when a metric should be dropped: its name or any attribute name
     * is on the forbidden list, or any attribute value matches a forbidden
     * pattern (defensive gate).
     */
    fun isForbiddenMetric(name: String, attributes: Map<String, String>): Boolean {
        if (name in FORBIDDEN_METRIC_TAG_NAMES) return true
        for ((tagName, tagValue) in attributes) {
            if (tagName in FORBIDDEN_METRIC_TAG_NAMES) return true
            if (FORBIDDEN_METRIC_VALUE_PATTERNS.any { it.containsMatchIn(tagValue) }) {
                return true
            }
        }
        return false
    }
}
