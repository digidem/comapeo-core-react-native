import Foundation

/// Typed view of the Info.plist keys `app.plugin.js` writes at
/// prebuild. `nil` when DSN absent (Sentry off).
struct SentryConfig: Equatable {
    let dsn: String
    let environment: String
    let release: String
    let sampleRate: Double?
    let tracesSampleRate: Double?
    /// Cap on RPC argument bytes captured. Default: never capture.
    let rpcArgsBytes: Int?
    /// Default for fresh installs. `nil` → `true`. User's explicit
    /// write wins thereafter.
    let diagnosticsEnabledDefault: Bool?
    /// Default for fresh installs. `nil` → `false`.
    let captureApplicationDataDefault: Bool?
    /// Opt in to `SentrySDK.logger.*`. `nil`/`false` → logger no-ops.
    let enableLogs: Bool?

    /// Subset that maps cleanly to JS-side `Sentry.init` options;
    /// plugin-internal fields excluded. Spread on the JS side as
    /// `Sentry.init({ ...sentryConfig, ...mine })`.
    func toSentryInitMap() -> [String: Any] {
        var map: [String: Any] = [
            "dsn": dsn,
            "environment": environment,
            "release": release,
        ]
        if let sampleRate = sampleRate { map["sampleRate"] = sampleRate }
        if let tracesSampleRate = tracesSampleRate { map["tracesSampleRate"] = tracesSampleRate }
        if let enableLogs = enableLogs { map["enableLogs"] = enableLogs }
        return map
    }

    /// Must stay in sync with `app.plugin.js`'s `IOS_KEYS`.
    enum Key {
        static let dsn = "ComapeoCoreSentryDsn"
        static let environment = "ComapeoCoreSentryEnvironment"
        static let release = "ComapeoCoreSentryRelease"
        static let sampleRate = "ComapeoCoreSentrySampleRate"
        static let tracesSampleRate = "ComapeoCoreSentryTracesSampleRate"
        static let rpcArgsBytes = "ComapeoCoreSentryRpcArgsBytes"
        static let diagnosticsEnabledDefault = "ComapeoCoreSentryDiagnosticsEnabledDefault"
        static let captureApplicationDataDefault = "ComapeoCoreSentryCaptureApplicationDataDefault"
        static let enableLogs = "ComapeoCoreSentryEnableLogs"
    }

    /// Default release: `CFBundleShortVersionString+CFBundleVersion`
    /// so successive EAS builds of the same marketing version differ.
    static func loadFromMainBundle() -> SentryConfig? {
        let info = Bundle.main.infoDictionary ?? [:]
        return load(
            from: info,
            defaultRelease: { resolveDefaultRelease(info: info) }
        )
    }

    /// Pure variant for unit testing. A stale prebuild missing
    /// `environment` logs loud and returns nil rather than crashing.
    static func load(
        from info: [String: Any],
        defaultRelease: () -> String
    ) -> SentryConfig? {
        guard let dsn = info[Key.dsn] as? String, !dsn.isEmpty else {
            return nil
        }
        guard let environment = info[Key.environment] as? String, !environment.isEmpty else {
            NSLog(
                "[ComapeoCore.SentryConfig] %@ missing from Info.plist while " +
                "%@ is set. Re-run `expo prebuild` so the plugin can " +
                "rewrite the plist. Sentry disabled until then.",
                Key.environment, Key.dsn
            )
            return nil
        }
        let release = (info[Key.release] as? String) ?? defaultRelease()
        return SentryConfig(
            dsn: dsn,
            environment: environment,
            release: release,
            sampleRate: parseDouble(info[Key.sampleRate]),
            tracesSampleRate: parseDouble(info[Key.tracesSampleRate]),
            rpcArgsBytes: parseInt(info[Key.rpcArgsBytes]),
            diagnosticsEnabledDefault: parseStrictBool(
                info[Key.diagnosticsEnabledDefault]
            ),
            captureApplicationDataDefault: parseStrictBool(
                info[Key.captureApplicationDataDefault]
            ),
            enableLogs: parseStrictBool(info[Key.enableLogs])
        )
    }

    private static func resolveDefaultRelease(info: [String: Any]) -> String {
        let version = (info["CFBundleShortVersionString"] as? String) ?? "unknown"
        let build = (info["CFBundleVersion"] as? String) ?? "0"
        return "\(version)+\(build)"
    }

    /// Plugin stringifies numerics for Android-parity (manifest
    /// meta-data is string-typed). Accept both shapes.
    private static func parseDouble(_ value: Any?) -> Double? {
        if let s = value as? String { return Double(s) }
        if let d = value as? Double { return d }
        if let i = value as? Int { return Double(i) }
        return nil
    }

    private static func parseInt(_ value: Any?) -> Int? {
        if let s = value as? String { return Int(s) }
        if let i = value as? Int { return i }
        return nil
    }

    /// Strict: only "true"/"false" or a real `Bool`. A stray
    /// "1"/"yes" returns nil so a hand-edited plist can't silently
    /// flip the native default.
    private static func parseStrictBool(_ value: Any?) -> Bool? {
        if let b = value as? Bool { return b }
        if let s = value as? String {
            switch s {
            case "true": return true
            case "false": return false
            default: return nil
            }
        }
        return nil
    }
}
