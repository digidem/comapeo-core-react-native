import Foundation

/// One `MXMetricPayload`'s `applicationExitMetrics`, reduced to the fields
/// we forward. Built from MetricKit by [AppExitMetricsCollector] on iOS;
/// built by hand in tests (`MXMetricPayload` can't be instantiated directly
/// before iOS 17, and MetricKit doesn't exist in the macOS swift-test
/// target).
struct AppExitPayloadData {
    var windowStart: Date
    var windowEnd: Date
    var appVersion: String?
    var osVersion: String?
    /// Bucket name → cumulative exit count for the window, e.g.
    /// `"memory_pressure": 3`. Names per [AppExitDecoder]'s taxonomy.
    var foreground: [String: Int]
    var background: [String: Int]
}

/// Decodes `MXAppExitMetric` buckets into Sentry events. Pure logic, no
/// MetricKit import, so the whole taxonomy is unit-testable on macOS.
///
/// Emission: at the app-usage tier, one event **per individual exit** — a
/// bucket count of 3 emits three identical events so dashboard queries are a
/// trivial `count(*)` — capped at [maxEventsPerBucket] per window+bucket
/// (counts are 24h cumulative totals; benign buckets like background
/// `normal_app_exit` reach the hundreds and would burn Sentry quota in a
/// burst). At the diagnostic tier the duplication is collapsed to one event
/// per window+bucket (frequency is session-shape data). The true count
/// always rides in the `window_count` extra — use `sum(window_count)` over
/// one event per window when exactness matters.
enum AppExitDecoder {
    /// Mirrors Android's per-process record cap (`MAX_RECORDS`).
    static let maxEventsPerBucket = 10

    struct Event {
        let message: String
        let level: LogLevel
        let tags: [String: String]
        let extras: [String: Any]
    }

    static func events(
        from payload: AppExitPayloadData,
        captureApplicationData: Bool
    ) -> [Event] {
        var out: [Event] = []
        for (cohort, counts) in [
            ("foreground", payload.foreground),
            ("background", payload.background),
        ] {
            for (bucket, count) in counts.sorted(by: { $0.key < $1.key }) {
                guard count > 0 else { continue }
                let event = decode(
                    cohort: cohort,
                    bucket: bucket,
                    count: count,
                    payload: payload
                )
                out.append(
                    contentsOf: Array(
                        repeating: event,
                        count: captureApplicationData ? min(count, maxEventsPerBucket) : 1
                    )
                )
            }
        }
        return out
    }

    private static func decode(
        cohort: String,
        bucket: String,
        count: Int,
        payload: AppExitPayloadData
    ) -> Event {
        // `background_task_assertion_timeout` already carries its cohort.
        let fullName = bucket.hasPrefix("\(cohort)_") ? bucket : "\(cohort)_\(bucket)"
        // Stable across the duplicate events for one window+bucket, so
        // analyses can collapse back to distinct windows via
        // `count_unique(window_id)`.
        let windowId =
            "\(Int64(payload.windowStart.timeIntervalSince1970 * 1000))-\(fullName)"
        var extras: [String: Any] = [
            "window_count": count,
            "window_start_iso": iso(payload.windowStart),
            "window_end_iso": iso(payload.windowEnd),
            "window_duration_seconds":
                Int(payload.windowEnd.timeIntervalSince(payload.windowStart)),
        ]
        if let appVersion = payload.appVersion { extras["app_version"] = appVersion }
        if let osVersion = payload.osVersion { extras["os_version"] = osVersion }
        return Event(
            message: "ios exit: \(fullName)",
            level: level(forBucket: bucket, cohort: cohort),
            tags: [
                SentryTags.exitCohort: cohort,
                SentryTags.exitBucket: bucket,
                SentryTags.exitIntentional: bucket == "normal_app_exit" ? "true" : "false",
                SentryTags.exitCauseClass: causeClass(forBucket: bucket),
                SentryTags.windowId: windowId,
            ],
            extras: extras
        )
    }

    /// Higher-level grouping for dashboards. Unknown buckets (future iOS
    /// versions can add them) degrade to `unknown`, not a crash.
    static func causeClass(forBucket bucket: String) -> String {
        switch bucket {
        case "memory_resource_limit", "memory_pressure", "cpu_resource_limit":
            return "memory"
        case "app_watchdog", "background_task_assertion_timeout":
            return "watchdog"
        case "bad_access", "illegal_instruction", "abnormal":
            return "crash"
        case "suspended_with_locked_file":
            return "lock"
        case "normal_app_exit":
            return "normal"
        default:
            return "unknown"
        }
    }

    /// `error` for the background/battery-kill and user-visible-quality
    /// cohorts; `warning` where another sentry-cocoa integration captured
    /// the death itself, so kill-rate dashboards don't double-count it
    /// (the crash reporter owns crash buckets; watchdog-termination
    /// tracking owns *foreground* OOM/watchdog deaths — this is just the
    /// matching post-mortem count); `info` for intentional or benign
    /// exits — and for unknown buckets.
    static func level(forBucket bucket: String, cohort: String) -> LogLevel {
        switch bucket {
        case "memory_resource_limit", "app_watchdog":
            return cohort == "foreground" ? .warning : .error
        case "memory_pressure", "cpu_resource_limit",
             "background_task_assertion_timeout":
            return .error
        case "bad_access", "illegal_instruction", "abnormal":
            return .warning
        default:
            return .info
        }
    }

    private static let isoFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter
    }()

    private static func iso(_ date: Date) -> String {
        isoFormatter.string(from: date)
    }
}

#if canImport(MetricKit) && os(iOS)
import MetricKit

/// Subscribes to `MXMetricPayload` deliveries and forwards `MXAppExitMetric`
/// buckets as Sentry events. sentry-cocoa only subscribes to MetricKit's
/// *diagnostic* side (`MXHangDiagnostic` etc.) — the metric side, where
/// `MXAppExitMetric` lives, is an explicit gap we close here.
///
/// Deliveries are 24h aggregates arriving at unpredictable times (often ~24h
/// after launch, possibly mid-session), so the collector must stay alive for
/// the whole process — [subscribeOnce] retains it statically. There is no
/// back-fill: the first day after a fresh install reports nothing.
final class AppExitMetricsCollector: NSObject, MXMetricManagerSubscriber {
    private let captureApplicationData: Bool

    init(captureApplicationData: Bool) {
        self.captureApplicationData = captureApplicationData
    }

    /// Subscribing more than once produces duplicate deliveries; the static
    /// slot is both the once-guard and the lifetime retain.
    private static var shared: AppExitMetricsCollector?

    static func subscribeOnce(captureApplicationData: Bool) {
        guard shared == nil else { return }
        let collector = AppExitMetricsCollector(captureApplicationData: captureApplicationData)
        shared = collector
        // `MXMetricManager.shared.add` requires the main actor on iOS 17+.
        DispatchQueue.main.async {
            MXMetricManager.shared.add(collector)
            log("AppExitMetricsCollector subscribed to MXMetricManager")
        }
    }

    /// Best-effort cleanliness — `applicationWillTerminate` doesn't fire on
    /// system kills.
    static func unsubscribe() {
        guard let collector = shared else { return }
        shared = nil
        MXMetricManager.shared.remove(collector)
    }

    func didReceive(_ payloads: [MXMetricPayload]) {
        for payload in payloads {
            // Optional: iOS delivers payloads with no exit data on quiet days.
            guard let exits = payload.applicationExitMetrics else { continue }
            let foreground = exits.foregroundExitData
            let background = exits.backgroundExitData
            let data = AppExitPayloadData(
                windowStart: payload.timeStampBegin,
                windowEnd: payload.timeStampEnd,
                appVersion: payload.metaData?.applicationBuildVersion,
                osVersion: payload.metaData?.osVersion,
                foreground: [
                    "normal_app_exit": foreground.cumulativeNormalAppExitCount,
                    "memory_resource_limit": foreground.cumulativeMemoryResourceLimitExitCount,
                    "bad_access": foreground.cumulativeBadAccessExitCount,
                    "abnormal": foreground.cumulativeAbnormalExitCount,
                    "illegal_instruction": foreground.cumulativeIllegalInstructionExitCount,
                    "app_watchdog": foreground.cumulativeAppWatchdogExitCount,
                ],
                background: [
                    "normal_app_exit": background.cumulativeNormalAppExitCount,
                    "memory_resource_limit": background.cumulativeMemoryResourceLimitExitCount,
                    "bad_access": background.cumulativeBadAccessExitCount,
                    "abnormal": background.cumulativeAbnormalExitCount,
                    "illegal_instruction": background.cumulativeIllegalInstructionExitCount,
                    "app_watchdog": background.cumulativeAppWatchdogExitCount,
                    "memory_pressure": background.cumulativeMemoryPressureExitCount,
                    "suspended_with_locked_file": background.cumulativeSuspendedWithLockedFileExitCount,
                    "background_task_assertion_timeout":
                        background.cumulativeBackgroundTaskAssertionTimeoutExitCount,
                    "cpu_resource_limit": background.cumulativeCPUResourceLimitExitCount,
                ]
            )
            let events = AppExitDecoder.events(
                from: data,
                captureApplicationData: captureApplicationData
            )
            guard !events.isEmpty else { continue }
            logCrumb(
                category: SentryCategories.exit,
                message: "reporting \(events.count) app-exit event(s) from MetricKit window"
            )
            // Capture from MetricKit's delivery queue is fine — sentry-cocoa
            // is thread-safe.
            for event in events {
                SentryNativeBridge.captureMessage(
                    event.message,
                    level: event.level,
                    tags: event.tags,
                    extras: event.extras
                )
            }
        }
    }
}
#endif
