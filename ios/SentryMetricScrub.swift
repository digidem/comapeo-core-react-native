import Foundation

/// Forbidden-name/value gate for metrics emitted through the native SDK,
/// mirroring the `isForbiddenMetric` check the JS/Node paths run.
/// Hand-mirrored from `src/sentry-scrub.ts` and `backend/before-send.js`
/// (three module systems, so no build-time copy is practical) — keep the
/// lists in lock-step; each file points at the others.
enum SentryMetricScrub {
    private static let forbiddenMetricTagNames: Set<String> = [
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
    ]

    private static let forbiddenMetricValuePatterns: [NSRegularExpression] = [
        // swiftlint:disable:next force_try
        try! NSRegularExpression(
            pattern: #"\b(?:latitude|longitude|lat|lng|lon)\b\s*["']?\s*[:=]\s*-?\d+(?:\.\d+)?"#,
            options: [.caseInsensitive]
        ),
    ]

    /// `true` when a metric should be dropped: its name or any attribute name
    /// is on the forbidden list, or any string attribute value matches a
    /// forbidden pattern (defensive gate).
    static func isForbiddenMetric(name: String, attributes: [String: Any]) -> Bool {
        if forbiddenMetricTagNames.contains(name) { return true }
        for (tagName, tagValue) in attributes {
            if forbiddenMetricTagNames.contains(tagName) { return true }
            if let string = tagValue as? String, matchesForbiddenPattern(string) {
                return true
            }
        }
        return false
    }

    private static func matchesForbiddenPattern(_ value: String) -> Bool {
        let range = NSRange(value.startIndex..., in: value)
        return forbiddenMetricValuePatterns.contains {
            $0.firstMatch(in: value, options: [], range: range) != nil
        }
    }
}
