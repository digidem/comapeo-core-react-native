import XCTest

@testable import ComapeoCore

/// Tests for [AppExitDecoder] — the pure decode side of the MetricKit
/// app-exit forwarding. The `MXMetricManagerSubscriber` adapter is iOS-only
/// and exercised by eye on device; everything it feeds the decoder is
/// represented here by hand-built `AppExitPayloadData`.
final class AppExitMetricsCollectorTests: XCTestCase {

    private let windowStart = Date(timeIntervalSince1970: 1_700_000_000)
    private let windowEnd = Date(timeIntervalSince1970: 1_700_000_000 + 86_400)

    private func payload(
        foreground: [String: Int] = [:],
        background: [String: Int] = [:],
        appVersion: String? = "123",
        osVersion: String? = "17.5"
    ) -> AppExitPayloadData {
        AppExitPayloadData(
            windowStart: windowStart,
            windowEnd: windowEnd,
            appVersion: appVersion,
            osVersion: osVersion,
            foreground: foreground,
            background: background
        )
    }

    func testZeroCountBucketsEmitNothing() {
        let metrics = AppExitDecoder.metrics(
            from: payload(
                foreground: ["normal_app_exit": 0, "app_watchdog": 0],
                background: ["memory_pressure": 0]
            )
        )
        XCTAssertTrue(metrics.isEmpty)
    }

    func testBackgroundMemoryPressureCarriesExpectedAttributes() {
        let metrics = AppExitDecoder.metrics(from: payload(background: ["memory_pressure": 1]))
        XCTAssertEqual(metrics.count, 1)
        let metric = metrics[0]
        XCTAssertEqual(metric.value, 1)
        XCTAssertEqual(metric.attributes[SentryTags.exitCohort] as? String, "background")
        XCTAssertEqual(metric.attributes[SentryTags.exitBucket] as? String, "memory_pressure")
        XCTAssertEqual(metric.attributes[SentryTags.exitIntentional] as? Bool, false)
        XCTAssertEqual(metric.attributes[SentryTags.exitCauseClass] as? String, "memory")
        XCTAssertEqual(metric.attributes[SentryTags.exitSeverity] as? String, "error")
        XCTAssertEqual(metric.attributes["window_start_iso"] as? String, "2023-11-14T22:13:20Z")
        XCTAssertEqual(metric.attributes["window_end_iso"] as? String, "2023-11-15T22:13:20Z")
        XCTAssertEqual(metric.attributes["window_duration_seconds"] as? Int, 86_400)
        XCTAssertEqual(metric.attributes["app_version"] as? String, "123")
        XCTAssertEqual(metric.attributes["os_version"] as? String, "17.5")
    }

    func testBucketCountBecomesMetricValueNotDuplication() {
        let metrics = AppExitDecoder.metrics(from: payload(background: ["memory_pressure": 3]))
        XCTAssertEqual(metrics.count, 1)
        XCTAssertEqual(metrics[0].value, 3)
    }

    func testForegroundWatchdogIsWarningAndNormalExitIsIntentionalInfo() {
        // Foreground watchdog/OOM deaths are already captured by
        // sentry-cocoa's watchdog-termination tracking; the MetricKit count
        // is demoted so kill-rate dashboards don't double-count them.
        let metrics = AppExitDecoder.metrics(
            from: payload(foreground: ["app_watchdog": 1, "normal_app_exit": 2])
        )
        XCTAssertEqual(metrics.count, 2)
        let watchdog = metrics.first {
            $0.attributes[SentryTags.exitBucket] as? String == "app_watchdog"
        }!
        XCTAssertEqual(watchdog.attributes[SentryTags.exitCohort] as? String, "foreground")
        XCTAssertEqual(watchdog.attributes[SentryTags.exitSeverity] as? String, "warning")
        XCTAssertEqual(watchdog.attributes[SentryTags.exitCauseClass] as? String, "watchdog")
        let normal = metrics.first {
            $0.attributes[SentryTags.exitBucket] as? String == "normal_app_exit"
        }!
        XCTAssertEqual(normal.value, 2)
        XCTAssertEqual(normal.attributes[SentryTags.exitIntentional] as? Bool, true)
        XCTAssertEqual(normal.attributes[SentryTags.exitSeverity] as? String, "info")
        XCTAssertEqual(normal.attributes[SentryTags.exitCauseClass] as? String, "normal")
    }

    func testWatchdogClassBucketsSplitSeverityByCohort() {
        // sentry-cocoa's watchdog-termination heuristic only covers
        // foreground deaths — background stays error.
        let metrics = AppExitDecoder.metrics(
            from: payload(
                foreground: ["memory_resource_limit": 1, "app_watchdog": 1],
                background: ["memory_resource_limit": 1, "app_watchdog": 1]
            )
        )
        XCTAssertEqual(metrics.count, 4)
        for metric in metrics {
            let expected =
                metric.attributes[SentryTags.exitCohort] as? String == "foreground"
                ? "warning" : "error"
            XCTAssertEqual(
                metric.attributes[SentryTags.exitSeverity] as? String,
                expected,
                "\(metric.attributes[SentryTags.exitBucket] ?? "?")"
            )
        }
    }

    func testCrashBucketsAreWarnings() {
        let metrics = AppExitDecoder.metrics(
            from: payload(
                foreground: ["bad_access": 1],
                background: ["illegal_instruction": 1, "abnormal": 1]
            )
        )
        XCTAssertEqual(metrics.count, 3)
        for metric in metrics {
            XCTAssertEqual(metric.attributes[SentryTags.exitSeverity] as? String, "warning")
            XCTAssertEqual(metric.attributes[SentryTags.exitCauseClass] as? String, "crash")
            XCTAssertEqual(metric.attributes[SentryTags.exitIntentional] as? Bool, false)
        }
    }

    func testBackgroundTaskAssertionTimeoutClassifiesAsWatchdogError() {
        let metrics = AppExitDecoder.metrics(
            from: payload(background: ["background_task_assertion_timeout": 1])
        )
        let metric = metrics[0]
        XCTAssertEqual(metric.attributes[SentryTags.exitCauseClass] as? String, "watchdog")
        XCTAssertEqual(metric.attributes[SentryTags.exitSeverity] as? String, "error")
    }

    func testSameBucketInBothCohortsEmitsSeparately() {
        let metrics = AppExitDecoder.metrics(
            from: payload(
                foreground: ["memory_resource_limit": 1],
                background: ["memory_resource_limit": 2]
            )
        )
        XCTAssertEqual(metrics.count, 2)
        XCTAssertEqual(
            Set(metrics.compactMap { $0.attributes[SentryTags.exitCohort] as? String }),
            ["foreground", "background"]
        )
    }

    func testUnknownBucketDegradesGracefully() {
        // Future iOS versions can add buckets; the decode helpers must fall
        // through, not crash.
        let metrics = AppExitDecoder.metrics(from: payload(background: ["thermal_shutdown": 1]))
        XCTAssertEqual(metrics.count, 1)
        let metric = metrics[0]
        XCTAssertEqual(metric.attributes[SentryTags.exitBucket] as? String, "thermal_shutdown")
        XCTAssertEqual(metric.attributes[SentryTags.exitCauseClass] as? String, "unknown")
        XCTAssertEqual(metric.attributes[SentryTags.exitSeverity] as? String, "info")
        XCTAssertEqual(metric.attributes[SentryTags.exitIntentional] as? Bool, false)
    }

    func testMissingMetadataOmitsVersionAttributes() {
        let metrics = AppExitDecoder.metrics(
            from: payload(
                background: ["memory_pressure": 1],
                appVersion: nil,
                osVersion: nil
            )
        )
        let metric = metrics[0]
        XCTAssertNil(metric.attributes["app_version"])
        XCTAssertNil(metric.attributes["os_version"])
    }
}
