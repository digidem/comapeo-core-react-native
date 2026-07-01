import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// Low-cardinality device classification. Buckets the device
/// into low/mid/high by RAM + CPU cores so a metric like
/// "low-end devices are 4× slower at observation.create" is a dashboard
/// query rather than a per-model cardinality explosion. Computed once at
/// process start and cached on `SentryConfig`. Mirrors `DeviceTags.kt`.
///
/// Raw model/manufacturer stay on the event/trace scope (native SDK
/// attaches them); only the bucket rides on metrics.
struct DeviceTags: Equatable {
    let platform: String
    let deviceClass: String
    let osMajor: String

    static let platformTag = "ios"

    static let classLow = "low"
    static let classMid = "mid"
    static let classHigh = "high"

    private static let gb: UInt64 = 1024 * 1024 * 1024

    /// Thresholds:
    ///   low:  < 3 GB RAM OR < 4 cores
    ///   mid:  3–6 GB AND 4–6 cores
    ///   high: ≥ 6 GB AND ≥ 6 cores
    ///
    /// A device high on one axis but low on the other falls to the lower
    /// class — the slow axis dominates perceived perf. Boundaries are
    /// inclusive at the lower edge of each higher band (exactly 3 GB /
    /// exactly 4 cores is the floor of `mid`).
    static func classify(totalMemBytes: UInt64, cores: Int) -> String {
        let ramHigh = totalMemBytes >= 6 * gb
        let ramMid = totalMemBytes >= 3 * gb
        let coresHigh = cores >= 6
        let coresMid = cores >= 4
        if ramHigh && coresHigh { return classHigh }
        if ramMid && coresMid { return classMid }
        return classLow
    }

    /// `ios.<major>` from a system-version string.
    static func osMajor(systemVersion: String) -> String {
        let major = systemVersion.split(separator: ".").first.map(String.init)
        let safe = (major?.isEmpty == false) ? major! : "0"
        return "\(platformTag).\(safe)"
    }

    static func compute() -> DeviceTags {
        let totalMem = ProcessInfo.processInfo.physicalMemory
        let cores = ProcessInfo.processInfo.processorCount
        #if canImport(UIKit)
        let version = UIDevice.current.systemVersion
        #else
        let v = ProcessInfo.processInfo.operatingSystemVersion
        let version = "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
        #endif
        return DeviceTags(
            platform: platformTag,
            deviceClass: classify(totalMemBytes: totalMem, cores: cores),
            osMajor: osMajor(systemVersion: version)
        )
    }
}
