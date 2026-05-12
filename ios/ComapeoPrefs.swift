import Foundation

/// Persistent storage for sentry-related user preferences. Snapshot-
/// at-launch semantics: read at app delegate init / module construction
/// so toggle changes only take effect after the next launch. Toggle-
/// flip to `false` also wipes the on-disk sentry-cocoa cache so any
/// events the current session queued never reach the wire.
///
/// Mirrors `ComapeoPrefs.kt` — same key names, same defaults, same
/// privacy semantics. iOS is single-process so there's no cross-process
/// snapshot concern; the file exists in the same shape as Android purely
/// for symmetry.
///
/// Constructor takes pure read/write closures so the unit test stays
/// independent of a real `UserDefaults` instance.
final class ComapeoPrefs {
    struct Defaults {
        let diagnosticsEnabled: Bool
        let captureApplicationData: Bool
    }

    private let readBool: (String) -> Bool?
    private let writeBool: (String, Bool) -> Void
    private let defaults: Defaults

    init(
        readBool: @escaping (String) -> Bool?,
        writeBool: @escaping (String, Bool) -> Void,
        defaults: Defaults
    ) {
        self.readBool = readBool
        self.writeBool = writeBool
        self.defaults = defaults
    }

    /// User's saved value, or the plugin/baked default if absent.
    func readDiagnosticsEnabled() -> Bool {
        return readBool(Key.diagnosticsEnabled) ?? defaults.diagnosticsEnabled
    }

    /// User's saved value, or the plugin/baked default if absent.
    func readCaptureApplicationData() -> Bool {
        return readBool(Key.captureApplicationData) ?? defaults.captureApplicationData
    }

    func writeDiagnosticsEnabled(_ value: Bool) {
        writeBool(Key.diagnosticsEnabled, value)
    }

    func writeCaptureApplicationData(_ value: Bool) {
        writeBool(Key.captureApplicationData, value)
    }

    enum Key {
        static let diagnosticsEnabled = "sentry.diagnosticsEnabled"
        static let captureApplicationData = "sentry.captureApplicationData"
    }

    /// Diagnostics default-default — privacy model treats baseline
    /// error visibility as on.
    static let defaultDiagnosticsEnabled: Bool = true
    /// Capture-application-data default-default — off until user opts in.
    static let defaultCaptureApplicationData: Bool = false

    /// Construct using `UserDefaults.standard` and the plist-supplied
    /// defaults (from `SentryConfig.loadFromMainBundle`). When the
    /// plugin didn't ship a default, falls back to the baked-in
    /// `defaultDiagnosticsEnabled` / `defaultCaptureApplicationData`.
    static func open() -> ComapeoPrefs {
        let sentryConfig = SentryConfig.loadFromMainBundle()
        let defaults = Defaults(
            diagnosticsEnabled: sentryConfig?.diagnosticsEnabledDefault
                ?? defaultDiagnosticsEnabled,
            captureApplicationData: sentryConfig?.captureApplicationDataDefault
                ?? defaultCaptureApplicationData
        )
        let store = UserDefaults.standard
        return ComapeoPrefs(
            readBool: { key in
                // `object(forKey:)` distinguishes "absent" (nil) from
                // "explicit false" (NSNumber 0); `bool(forKey:)` collapses
                // them, which would silently re-enable diagnostics every
                // time a user wrote `false`.
                guard let value = store.object(forKey: key) as? Bool else { return nil }
                return value
            },
            writeBool: { key, value in
                store.set(value, forKey: key)
            },
            defaults: defaults
        )
    }

    /// Recursively delete sentry-cocoa's on-disk cache root.
    /// Path: `<NSCachesDirectory>/io.sentry/` — sentry-cocoa's
    /// documented default (`SentryFileManager.m`'s `basePath`). Wipes
    /// pending envelopes, sessions, and scope state in one shot so a
    /// `diagnosticsEnabled=false` flip can't ship anything from the
    /// current session on next launch.
    ///
    /// Best-effort: a filesystem error never blocks the privacy
    /// opt-out. The worst case is the cache survives one more launch,
    /// but that launch won't init Sentry (diagnostics is off), so
    /// nothing will read it.
    static func wipeSentryOutbox() {
        guard let caches = FileManager.default
            .urls(for: .cachesDirectory, in: .userDomainMask)
            .first else { return }
        wipeSentryOutbox(at: caches.appendingPathComponent("io.sentry", isDirectory: true))
    }

    /// Path-taking variant exposed for unit testing — production
    /// callers use the no-arg overload above. The
    /// `io.sentry` subdir choice lives in the caller; this method
    /// just deletes whatever URL it's handed, recursively. A
    /// missing directory is success, not an error.
    static func wipeSentryOutbox(at url: URL) {
        try? FileManager.default.removeItem(at: url)
    }
}
