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

/// Decodes `MXAppExitMetric` buckets into `comapeo.app.exit` count metrics —
/// metrics, not events, because the goal is aggregate statistics, not
/// per-incident triage in the Issues UI. One count per non-zero
/// window+bucket, with the bucket's cumulative value as the metric value.
/// Pure logic, no MetricKit or Sentry import, so the whole taxonomy is
/// unit-testable on macOS.
enum AppExitDecoder {
    /// One `comapeo.app.exit` count emission. `value` is the bucket's
    /// cumulative exit count for the 24h window.
    struct Metric {
        let value: Int
        let attributes: [String: Any]
    }

    static func metrics(from payload: AppExitPayloadData) -> [Metric] {
        var out: [Metric] = []
        for (cohort, counts) in [
            ("foreground", payload.foreground),
            ("background", payload.background),
        ] {
            for (bucket, count) in counts.sorted(by: { $0.key < $1.key }) {
                guard count > 0 else { continue }
                out.append(decode(cohort: cohort, bucket: bucket, count: count, payload: payload))
            }
        }
        return out
    }

    private static func decode(
        cohort: String,
        bucket: String,
        count: Int,
        payload: AppExitPayloadData
    ) -> Metric {
        var attributes: [String: Any] = [
            SentryTags.exitCohort: cohort,
            SentryTags.exitBucket: bucket,
            SentryTags.exitIntentional: bucket == "normal_app_exit",
            SentryTags.exitCauseClass: causeClass(forBucket: bucket),
            SentryTags.exitSeverity: severity(forBucket: bucket),
            "window_start_iso": iso(payload.windowStart),
            "window_end_iso": iso(payload.windowEnd),
            "window_duration_seconds":
                Int(payload.windowEnd.timeIntervalSince(payload.windowStart)),
        ]
        if let appVersion = payload.appVersion { attributes["app_version"] = appVersion }
        if let osVersion = payload.osVersion { attributes["os_version"] = osVersion }
        return Metric(value: count, attributes: attributes)
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

    /// `exit.severity` attribute (metrics have no event level): `error` for
    /// the background/battery-kill and user-visible-quality buckets;
    /// `warning` where sentry-cocoa's own crash reporter captured the actual
    /// crash (this is just the matching post-mortem count); `info` for
    /// intentional or benign exits — and for unknown buckets.
    static func severity(forBucket bucket: String) -> String {
        switch bucket {
        case "memory_resource_limit", "memory_pressure", "cpu_resource_limit",
             "app_watchdog", "background_task_assertion_timeout":
            return "error"
        case "bad_access", "illegal_instruction", "abnormal":
            return "warning"
        default:
            return "info"
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
/// buckets as `comapeo.app.exit` count metrics. sentry-cocoa only subscribes
/// to MetricKit's *diagnostic* side (`MXHangDiagnostic` etc.) — the metric
/// side, where `MXAppExitMetric` lives, is an explicit gap we close here.
///
/// Deliveries are 24h aggregates arriving at unpredictable times (often ~24h
/// after launch, possibly mid-session), so the collector must stay alive for
/// the whole process — [subscribeOnce] retains it statically. There is no
/// back-fill: the first day of data after a fresh install is lost.
final class AppExitMetricsCollector: NSObject, MXMetricManagerSubscriber {

    /// Subscribing more than once produces duplicate deliveries; the static
    /// slot is both the once-guard and the lifetime retain.
    private static var shared: AppExitMetricsCollector?

    static func subscribeOnce() {
        guard shared == nil else { return }
        let collector = AppExitMetricsCollector()
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
            let metrics = AppExitDecoder.metrics(from: data)
            guard !metrics.isEmpty else { continue }
            logCrumb(
                category: SentryCategories.exit,
                message: "reporting \(metrics.count) app-exit bucket(s) from MetricKit window"
            )
            // Capture from MetricKit's delivery queue is fine — sentry-cocoa
            // is thread-safe.
            for metric in metrics {
                SentryNativeBridge.countMetric(
                    SentryNativeBridge.appExitMetricName,
                    value: UInt(metric.value),
                    attributes: metric.attributes
                )
            }
        }
    }
}
#endif
