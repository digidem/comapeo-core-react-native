import Foundation

/// Typed view of the Info.plist keys the Expo plugin
/// (`app.plugin.js`) writes at prebuild time. `loadFromMainBundle`
/// returns `nil` when no DSN is present (Sentry off).
///
/// iOS is single-process; the host's `@sentry/react-native`
/// already initialises sentry-cocoa. This module just reads
/// config to attach native-side breadcrumbs / spans (see
/// SentryNativeBridge.swift).
struct SentryConfig: Equatable {
    let dsn: String
    let environment: String
    let release: String
    let sampleRate: Double?
    let tracesSampleRate: Double?
    /// Cap on RPC argument bytes captured. Defaults to never capture.
    let rpcArgsBytes: Int?
    /// Default for the capture-application-data toggle on fresh
    /// installs. `nil` → treated as `false`.
    let captureApplicationDataDefault: Bool?
    /// Opt in to Sentry structured logs (`SentrySDK.logger.*`).
    /// `nil` (or `false`) leaves logs off — `Sentry.logger.*`
    /// calls become no-ops.
    let enableLogs: Bool?

    /// Subset of fields that map cleanly to `Sentry.init` options
    /// on the host's `@sentry/react-native` side. Plugin-internal
    /// values (`rpcArgsBytes`, `captureApplicationDataDefault`)
    /// are deliberately excluded — they're not Sentry options.
    /// Sent to JS as the `sentryConfig` constant; consumers spread
    /// it into `Sentry.init({ ...sentryConfig, ...mine })`.
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
        static let captureApplicationDataDefault = "ComapeoCoreSentryCaptureApplicationDataDefault"
        static let enableLogs = "ComapeoCoreSentryEnableLogs"
    }

    /// Default release: `CFBundleShortVersionString + "+" +
    /// CFBundleVersion` so successive EAS builds of the same
    /// marketing version get distinct releases.
    static func loadFromMainBundle() -> SentryConfig? {
        let info = Bundle.main.infoDictionary ?? [:]
        return load(
            from: info,
            defaultRelease: { resolveDefaultRelease(info: info) }
        )
    }

    /// Pure variant for unit-testing. The plugin refuses to
    /// prebuild without `environment`, but a stale prebuild from
    /// before that validation was added would still ship — log
    /// loud and return nil (Sentry off) rather than crashing.
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
            captureApplicationDataDefault: parseStrictBool(
                info[Key.captureApplicationDataDefault]
            ),
            enableLogs: parseStrictBool(info[Key.enableLogs])
        )
    }

    /// Default release tag when the plugin didn't supply one
    /// (§4.1): `CFBundleShortVersionString + "+" + CFBundleVersion`.
    /// Falls back to "unknown+0" if either is absent — never
    /// reached on a properly-prebuilt app, but defensive against a
    /// misconfigured Info.plist crashing the loader.
    private static func resolveDefaultRelease(info: [String: Any]) -> String {
        let version = (info["CFBundleShortVersionString"] as? String) ?? "unknown"
        let build = (info["CFBundleVersion"] as? String) ?? "0"
        return "\(version)+\(build)"
    }

    /// Plugin coerces numeric values to strings on the way in to
    /// keep parity with the Android side (manifest meta-data is
    /// string-typed). Accept either a `String` or a `Double`/`Int`
    /// in case a hand-written plist uses native plist types.
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

    /// Strict bool parse: only "true"/"false" (or a real `Bool`)
    /// resolve to a value. A stray "1"/"yes" returns nil so the
    /// native default isn't silently flipped by a hand-edited
    /// plist.
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
