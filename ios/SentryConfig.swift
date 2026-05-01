import Foundation

/// Phase 2 of the Sentry integration plan
/// (docs/sentry-integration-plan.md §4.1, §4.2). Typed view of the
/// Info.plist keys the Expo plugin (`app.plugin.js`) writes at
/// prebuild time.
///
/// `loadFromBundle` returns `nil` when the DSN key is absent, which
/// is the consumer's signal that Sentry was not configured (the
/// plugin omits all entries when invoked without a `sentry`
/// argument, or when not registered at all). Treat nil as "Sentry
/// off" — do not init the SDK, do not pass `--sentryDsn` argv flags
/// to the embedded backend (Phase 3).
///
/// Phase 2 ships the data type and reader; the actual native-side
/// breadcrumb / span / event calls in `NodeJSService` are a Phase
/// 2.5 follow-up because they require linking against `Sentry`
/// (sentry-cocoa), which this PR deliberately doesn't add to the
/// podspec or SwiftPM target. iOS doesn't have the FGS-process
/// init split that Android has — the host app's
/// `@sentry/react-native` already covers the single-process SDK.
struct SentryConfig: Equatable {
    let dsn: String
    let environment: String
    let release: String
    let sampleRate: Double?
    let tracesSampleRate: Double?
    /// Cap on RPC argument bytes captured to Sentry. `nil` (or 0)
    /// means RPC arguments are never captured — the default. Only
    /// developer debug builds are expected to set this; see plan
    /// §7.4.9 for the never-capture list.
    let rpcArgsBytes: Int?
    /// Per-environment default for the §9 capture-application-data
    /// toggle when the user has not yet set it explicitly. `nil`
    /// means absent → native treats as `false`. Wired via the
    /// plugin so a consumer can opt internal/test builds in by
    /// default without changing JS code.
    let captureApplicationDataDefault: Bool?

    /// Info.plist keys. Must stay in sync with app.plugin.js's
    /// `IOS_KEYS`. Prefixed with `ComapeoCore` to avoid colliding
    /// with `@sentry/react-native`'s auto-config keys (`SentryDsn`,
    /// …) — those belong to the host's Sentry SDK init.
    enum Key {
        static let dsn = "ComapeoCoreSentryDsn"
        static let environment = "ComapeoCoreSentryEnvironment"
        static let release = "ComapeoCoreSentryRelease"
        static let sampleRate = "ComapeoCoreSentrySampleRate"
        static let tracesSampleRate = "ComapeoCoreSentryTracesSampleRate"
        static let rpcArgsBytes = "ComapeoCoreSentryRpcArgsBytes"
        static let captureApplicationDataDefault = "ComapeoCoreSentryCaptureApplicationDataDefault"
    }

    /// Production entry point. Reads `Bundle.main.infoDictionary`
    /// and falls back to `CFBundleShortVersionString +
    /// CFBundleVersion` for the release tag when the plugin didn't
    /// supply one (§4.1) — successive EAS builds of the same
    /// marketing version then get distinct release strings because
    /// EAS auto-increments `CFBundleVersion`.
    static func loadFromMainBundle() -> SentryConfig? {
        let info = Bundle.main.infoDictionary ?? [:]
        return load(
            from: info,
            defaultRelease: { resolveDefaultRelease(info: info) }
        )
    }

    /// Pure variant for unit-testing. Takes the plist-equivalent
    /// dictionary and a producer for the `release` fallback so
    /// tests can run without a real `Bundle.main.infoDictionary`.
    ///
    /// Returns nil when DSN is absent (sentry-off state).
    /// Hits a `fatalError` when DSN is present but `environment`
    /// is missing — that combination indicates a build
    /// misconfiguration the plugin should have refused at prebuild
    /// time. Failing loud is preferred to silently degrading;
    /// otherwise we'd ship Sentry events with no environment tag
    /// and they'd be impossible to filter.
    static func load(
        from info: [String: Any],
        defaultRelease: () -> String
    ) -> SentryConfig? {
        guard let dsn = info[Key.dsn] as? String, !dsn.isEmpty else {
            return nil
        }
        guard let environment = info[Key.environment] as? String, !environment.isEmpty else {
            fatalError(
                "comapeo: \(Key.environment) missing from Info.plist — the " +
                "Expo plugin should have refused this prebuild. " +
                "Re-run `expo prebuild` or check app.config.js."
            )
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
            )
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
