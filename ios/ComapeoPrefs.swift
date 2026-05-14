import Foundation

/// Persistent storage for sentry-related user preferences. Snapshot-
/// at-launch: toggle changes take effect on next launch; flipping to
/// `false` also wipes the sentry-cocoa cache so queued events don't
/// ship. Mirrors `ComapeoPrefs.kt`.
///
/// Constructor takes read/write closures so unit tests don't need a
/// real `UserDefaults`.
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

    func readDiagnosticsEnabled() -> Bool {
        readBool(Key.diagnosticsEnabled) ?? defaults.diagnosticsEnabled
    }

    func readCaptureApplicationData() -> Bool {
        readBool(Key.captureApplicationData) ?? defaults.captureApplicationData
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

    /// Privacy model treats baseline error visibility as on.
    static let defaultDiagnosticsEnabled: Bool = true
    /// Off until user opts in.
    static let defaultCaptureApplicationData: Bool = false

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
                // `object(forKey:)` distinguishes absent from explicit
                // `false`; `bool(forKey:)` collapses them, which would
                // silently re-enable diagnostics on every user `false`.
                store.object(forKey: key) as? Bool
            },
            writeBool: { key, value in
                store.set(value, forKey: key)
            },
            defaults: defaults
        )
    }

    /// Recursively delete sentry-cocoa's on-disk cache root at
    /// `<NSCachesDirectory>/io.sentry/` (sentry-cocoa's documented
    /// default). Wipes envelopes, sessions, and scope state so a
    /// `diagnosticsEnabled=false` flip can't ship anything from the
    /// current session.
    ///
    /// Best-effort: filesystem errors don't block the opt-out. Worst
    /// case the cache survives one more launch, where diagnostics is
    /// off so nothing reads it.
    static func wipeSentryOutbox() {
        guard let caches = FileManager.default
            .urls(for: .cachesDirectory, in: .userDomainMask)
            .first else { return }
        wipeSentryOutbox(at: caches.appendingPathComponent("io.sentry", isDirectory: true))
    }

    /// Path-taking variant for unit tests. Missing directory is success.
    static func wipeSentryOutbox(at url: URL) {
        try? FileManager.default.removeItem(at: url)
    }
}
