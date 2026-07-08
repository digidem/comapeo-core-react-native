import XCTest

@testable import ComapeoCore

/// Mirror of the `isForbiddenMetric` cases in `src/__tests__/sentry-scrub.test.js`
/// and `backend/lib/before-send.test.mjs` — the list is hand-mirrored across
/// the four layers, so the assertions are too.
final class SentryMetricScrubTests: XCTestCase {

    func testForbiddenMetricNameIsRejected() {
        XCTAssertTrue(
            SentryMetricScrub.isForbiddenMetric(name: "device.model", attributes: [:])
        )
    }

    func testForbiddenAttributeNameIsRejected() {
        XCTAssertTrue(
            SentryMetricScrub.isForbiddenMetric(
                name: "comapeo.app.exit",
                attributes: ["project_id": "abc123"]
            )
        )
        XCTAssertTrue(
            SentryMetricScrub.isForbiddenMetric(
                name: "comapeo.app.exit",
                attributes: ["locale": "es_PE"]
            )
        )
    }

    func testCoordinateShapedAttributeValueIsRejected() {
        XCTAssertTrue(
            SentryMetricScrub.isForbiddenMetric(
                name: "comapeo.app.exit",
                attributes: ["note": "lat=-12.05, lng=-77.03"]
            )
        )
    }

    func testNonStringAttributeValuesAreIgnoredByThePatternCheck() {
        XCTAssertFalse(
            SentryMetricScrub.isForbiddenMetric(
                name: "comapeo.app.exit",
                attributes: ["count": 3, "flag": true]
            )
        )
    }

    func testOrdinaryExitMetricAttributesPass() {
        XCTAssertFalse(
            SentryMetricScrub.isForbiddenMetric(
                name: SentryNativeBridge.appExitMetricName,
                attributes: [
                    SentryTags.exitCohort: "current",
                    SentryTags.exitBucket: "memory-pressure",
                    SentryTags.exitIntentional: "false",
                    SentryTags.exitCauseClass: "system",
                    SentryTags.exitSeverity: "warning",
                ]
            )
        )
    }
}
