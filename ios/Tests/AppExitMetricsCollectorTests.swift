import XCTest

@testable import ComapeoCore

/// Tests for [AppExitDecoder] — the pure decode side of Phase 7's MetricKit
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
        let events = AppExitDecoder.events(
            from: payload(
                foreground: ["normal_app_exit": 0, "app_watchdog": 0],
                background: ["memory_pressure": 0]
            ),
            captureApplicationData: true
        )
        XCTAssertTrue(events.isEmpty)
    }

    func testBackgroundMemoryPressureEmitsErrorWithExpectedTags() {
        let events = AppExitDecoder.events(
            from: payload(background: ["memory_pressure": 1]),
            captureApplicationData: true
        )
        XCTAssertEqual(events.count, 1)
        let event = events[0]
        XCTAssertEqual(event.message, "ios exit: background_memory_pressure")
        XCTAssertEqual(event.level, .error)
        XCTAssertEqual(event.tags[SentryTags.exitCohort], "background")
        XCTAssertEqual(event.tags[SentryTags.exitBucket], "memory_pressure")
        XCTAssertEqual(event.tags[SentryTags.exitIntentional], "false")
        XCTAssertEqual(event.tags[SentryTags.exitCauseClass], "memory")
        XCTAssertEqual(
            event.tags[SentryTags.windowId],
            "1700000000000-background_memory_pressure"
        )
        XCTAssertEqual(event.extras["window_count"] as? Int, 1)
        XCTAssertEqual(event.extras["window_start_iso"] as? String, "2023-11-14T22:13:20Z")
        XCTAssertEqual(event.extras["window_end_iso"] as? String, "2023-11-15T22:13:20Z")
        XCTAssertEqual(event.extras["window_duration_seconds"] as? Int, 86_400)
        XCTAssertEqual(event.extras["app_version"] as? String, "123")
        XCTAssertEqual(event.extras["os_version"] as? String, "17.5")
    }

    func testForegroundWatchdogIsWarningAndForegroundNormalExitIsInfo() {
        // Foreground watchdog/OOM deaths are already captured by
        // sentry-cocoa's watchdog-termination tracking; the MetricKit count
        // is demoted so kill-rate dashboards don't double-count them.
        let events = AppExitDecoder.events(
            from: payload(foreground: ["app_watchdog": 1, "normal_app_exit": 1]),
            captureApplicationData: true
        )
        XCTAssertEqual(events.count, 2)
        let watchdog = events.first { $0.tags[SentryTags.exitBucket] == "app_watchdog" }!
        XCTAssertEqual(watchdog.message, "ios exit: foreground_app_watchdog")
        XCTAssertEqual(watchdog.level, .warning)
        XCTAssertEqual(watchdog.tags[SentryTags.exitCauseClass], "watchdog")
        let normal = events.first { $0.tags[SentryTags.exitBucket] == "normal_app_exit" }!
        XCTAssertEqual(normal.level, .info)
        XCTAssertEqual(normal.tags[SentryTags.exitIntentional], "true")
        XCTAssertEqual(normal.tags[SentryTags.exitCauseClass], "normal")
    }

    func testWatchdogClassBucketsSplitLevelByCohort() {
        // sentry-cocoa's watchdog-termination heuristic only covers
        // foreground deaths — background stays error.
        let events = AppExitDecoder.events(
            from: payload(
                foreground: ["memory_resource_limit": 1, "app_watchdog": 1],
                background: ["memory_resource_limit": 1, "app_watchdog": 1]
            ),
            captureApplicationData: true
        )
        XCTAssertEqual(events.count, 4)
        for event in events {
            let expected: LogLevel =
                event.tags[SentryTags.exitCohort] == "foreground" ? .warning : .error
            XCTAssertEqual(event.level, expected, "\(event.message)")
        }
    }

    func testCrashBucketsAreWarnings() {
        let events = AppExitDecoder.events(
            from: payload(
                foreground: ["bad_access": 1],
                background: ["illegal_instruction": 1, "abnormal": 1]
            ),
            captureApplicationData: true
        )
        XCTAssertEqual(events.count, 3)
        for event in events {
            XCTAssertEqual(event.level, .warning)
            XCTAssertEqual(event.tags[SentryTags.exitCauseClass], "crash")
            XCTAssertEqual(event.tags[SentryTags.exitIntentional], "false")
        }
    }

    func testBackgroundTaskAssertionTimeoutDoesNotDoubleCohortPrefix() {
        let events = AppExitDecoder.events(
            from: payload(background: ["background_task_assertion_timeout": 1]),
            captureApplicationData: true
        )
        let event = events[0]
        XCTAssertEqual(event.message, "ios exit: background_task_assertion_timeout")
        XCTAssertEqual(event.tags[SentryTags.exitCauseClass], "watchdog")
        XCTAssertEqual(event.level, .error)
        XCTAssertEqual(
            event.tags[SentryTags.windowId],
            "1700000000000-background_task_assertion_timeout"
        )
    }

    func testPerExitDuplicationEmitsCountIdenticalEvents() {
        let events = AppExitDecoder.events(
            from: payload(background: ["memory_pressure": 3]),
            captureApplicationData: true
        )
        XCTAssertEqual(events.count, 3)
        let windowIds = Set(events.map { $0.tags[SentryTags.windowId] })
        XCTAssertEqual(windowIds.count, 1)
        for event in events {
            XCTAssertEqual(event.tags, events[0].tags)
            XCTAssertEqual(event.extras["window_count"] as? Int, 3)
        }
    }

    func testPerExitDuplicationIsCappedButKeepsTrueCount() {
        let events = AppExitDecoder.events(
            from: payload(background: ["normal_app_exit": 250]),
            captureApplicationData: true
        )
        XCTAssertEqual(events.count, AppExitDecoder.maxEventsPerBucket)
        for event in events {
            XCTAssertEqual(event.extras["window_count"] as? Int, 250)
        }
    }

    func testMultipleBucketsDuplicateIndependently() {
        let events = AppExitDecoder.events(
            from: payload(background: ["memory_pressure": 2, "app_watchdog": 1]),
            captureApplicationData: true
        )
        XCTAssertEqual(events.count, 3)
        let windowIds = Set(events.compactMap { $0.tags[SentryTags.windowId] })
        XCTAssertEqual(windowIds.count, 2)
    }

    func testSameBucketInBothCohortsGetsDistinctWindowIds() {
        let events = AppExitDecoder.events(
            from: payload(
                foreground: ["memory_resource_limit": 1],
                background: ["memory_resource_limit": 1]
            ),
            captureApplicationData: true
        )
        XCTAssertEqual(events.count, 2)
        XCTAssertEqual(Set(events.compactMap { $0.tags[SentryTags.windowId] }).count, 2)
        XCTAssertEqual(
            Set(events.compactMap { $0.tags[SentryTags.exitCohort] }),
            ["foreground", "background"]
        )
    }

    func testDiagnosticTierCollapsesDuplicationToOneEventPerBucket() {
        // Phase 9b.8: per-event multiplication is app-usage-tier — frequency
        // reveals session-shape activity. The true count still rides in the
        // window_count extra.
        let events = AppExitDecoder.events(
            from: payload(background: ["memory_pressure": 3, "app_watchdog": 2]),
            captureApplicationData: false
        )
        XCTAssertEqual(events.count, 2)
        let pressure = events.first { $0.tags[SentryTags.exitBucket] == "memory_pressure" }!
        XCTAssertEqual(pressure.extras["window_count"] as? Int, 3)
    }

    func testUnknownBucketDegradesGracefully() {
        // Future iOS versions can add buckets; the decode helpers must fall
        // through, not crash.
        let events = AppExitDecoder.events(
            from: payload(background: ["thermal_shutdown": 1]),
            captureApplicationData: true
        )
        XCTAssertEqual(events.count, 1)
        let event = events[0]
        XCTAssertEqual(event.message, "ios exit: background_thermal_shutdown")
        XCTAssertEqual(event.level, .info)
        XCTAssertEqual(event.tags[SentryTags.exitCauseClass], "unknown")
        XCTAssertEqual(event.tags[SentryTags.exitIntentional], "false")
    }

    func testMissingMetadataOmitsVersionExtras() {
        let events = AppExitDecoder.events(
            from: payload(
                background: ["memory_pressure": 1],
                appVersion: nil,
                osVersion: nil
            ),
            captureApplicationData: true
        )
        let event = events[0]
        XCTAssertNil(event.extras["app_version"])
        XCTAssertNil(event.extras["os_version"])
    }
}
