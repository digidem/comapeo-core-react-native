import Foundation
import Sentry

/// Trims the fields sentry-cocoa attaches to every event down to what each
/// privacy tier promises (docs/sentry-integration-plan.md §9b.3 / §9b.4).
/// Mirror of Android's `TierScopeEventProcessor`.
///
/// The diagnostic (default) tier keeps coarse hardware identity plus OS
/// name/version and app id/version/build; the fingerprint-friendly extras
/// (kernel version, OS build string, app name, locale + timezone, screen
/// metrics) only ship when the user opts into `applicationUsageData`.
///
/// Contexts are filtered through an allowlist rather than deleting a
/// denylist, so a field added by a future SDK version is dropped by default
/// instead of shipped by accident.
enum SentryScopeTier {
    private static let deviceKeysDiagnostic: Set<String> = [
        "manufacturer", "brand", "model", "model_id", "family", "arch", "archs",
        "simulator", "processor_count", "memory_size", "storage_size",
    ]
    private static let deviceKeysUsageExtra: Set<String> = [
        "screen_width_pixels", "screen_height_pixels", "screen_resolution",
        "screen_density", "screen_dpi", "screen_scale", "locale", "timezone",
    ]
    private static let osKeysDiagnostic: Set<String> = ["name", "version"]
    private static let osKeysUsageExtra: Set<String> = ["kernel_version", "build"]
    private static let appKeysDiagnostic: Set<String> = [
        "app_identifier", "app_version", "app_build",
    ]
    private static let appKeysUsageExtra: Set<String> = ["app_name"]

    /// The global tags every native event carries; anything else riding on a
    /// boot transaction is user-shape and dropped at the diagnostic tier.
    private static let bootTransactionTagAllowlist: Set<String> = [
        SentryTags.proc, SentryTags.layer,
    ]

    private static let gb: Int64 = 1 << 30

    /// `beforeSend` hook body. Mutates and returns the event.
    static func trimEvent(_ event: Event, applicationUsageData: Bool) -> Event {
        if var context = event.context {
            trim(&context, key: "device",
                 keep: deviceKeysDiagnostic, usageExtra: deviceKeysUsageExtra,
                 applicationUsageData: applicationUsageData)
            trim(&context, key: "os",
                 keep: osKeysDiagnostic, usageExtra: osKeysUsageExtra,
                 applicationUsageData: applicationUsageData)
            trim(&context, key: "app",
                 keep: appKeysDiagnostic, usageExtra: appKeysUsageExtra,
                 applicationUsageData: applicationUsageData)
            if !applicationUsageData {
                // Locale + timezone are high-entropy fingerprint surfaces.
                context["culture"] = nil
            }
            if var device = context["device"],
               let storage = device["storage_size"] as? NSNumber {
                device["storage_size"] = NSNumber(
                    value: bucketStorageSize(storage.int64Value)
                )
                context["device"] = device
            }
            event.context = context
        }
        // §9b.4: boot transactions carry only phase timings at diagnostic.
        if !applicationUsageData,
           event.type == "transaction",
           event.transaction == "comapeo.boot" {
            event.tags = event.tags?.filter {
                bootTransactionTagAllowlist.contains($0.key)
            }
        }
        return event
    }

    /// `beforeSendSpan` hook body: strip span data (e.g. rootkey `generated`)
    /// from boot phase spans at the diagnostic tier; timings, op, and the bare
    /// phase-name description stay.
    static func trimSpan(_ span: Span, applicationUsageData: Bool) -> Span {
        guard shouldStripBootSpanData(
            operation: span.operation,
            applicationUsageData: applicationUsageData
        ) else { return span }
        for key in span.data.keys {
            span.removeData(key: key)
        }
        return span
    }

    static func shouldStripBootSpanData(
        operation: String,
        applicationUsageData: Bool
    ) -> Bool {
        !applicationUsageData && operation.hasPrefix("boot.")
    }

    /// Round up to a standard marketed size (32/64/…/1024 GB) so exact
    /// formatted-capacity bytes can't fingerprint a device.
    static func bucketStorageSize(_ bytes: Int64) -> Int64 {
        var bucket = 32 * gb
        while bucket < bytes && bucket < 1024 * gb {
            bucket <<= 1
        }
        return bucket
    }

    private static func trim(
        _ context: inout [String: [String: Any]],
        key: String,
        keep: Set<String>,
        usageExtra: Set<String>,
        applicationUsageData: Bool
    ) {
        guard let block = context[key] else { return }
        var allowed = keep
        if applicationUsageData { allowed.formUnion(usageExtra) }
        context[key] = block.filter { allowed.contains($0.key) }
    }
}
