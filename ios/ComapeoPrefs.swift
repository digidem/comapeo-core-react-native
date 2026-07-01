import Foundation

/// Persistent storage for sentry-related user preferences. Snapshot-
/// at-launch: toggle changes take effect on next launch; flipping a
/// toggle to `false` also wipes the sentry-cocoa cache so queued events
/// don't ship. Mirrors `ComapeoPrefs.kt`.
///
/// Constructor takes read/write closures so unit tests don't need a
/// real `UserDefaults`.
final class ComapeoPrefs {
    struct Defaults {
        let diagnosticsEnabled: Bool
        let applicationUsageData: Bool
        let debug: Bool
    }

    private let readBool: (String) -> Bool?
    private let writeBool: (String, Bool) -> Void
    private let readDouble: (String) -> Double?
    private let writeDouble: (String, Double) -> Void
    private let removeKey: (String) -> Void
    private let defaults: Defaults
    /// Wall clock; injectable so 24h-auto-off tests don't depend on real time.
    private let now: () -> Double

    init(
        readBool: @escaping (String) -> Bool?,
        writeBool: @escaping (String, Bool) -> Void,
        readDouble: @escaping (String) -> Double?,
        writeDouble: @escaping (String, Double) -> Void,
        removeKey: @escaping (String) -> Void,
        defaults: Defaults,
        now: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 }
    ) {
        self.readBool = readBool
        self.writeBool = writeBool
        self.readDouble = readDouble
        self.writeDouble = writeDouble
        self.removeKey = removeKey
        self.defaults = defaults
        self.now = now
    }

    func readDiagnosticsEnabled() -> Bool {
        readBool(Key.diagnosticsEnabled) ?? defaults.diagnosticsEnabled
    }

    func readApplicationUsageData() -> Bool {
        readBool(Key.applicationUsageData) ?? defaults.applicationUsageData
    }

    /// Read the `debug` toggle, applying the 24h auto-off: if debug was
    /// switched on more than `debugMaxAgeMs` ago, flip it off, clear the
    /// timestamp, queue a `comapeo.debug.auto_disabled` breadcrumb, and
    /// return `false`. A `debug=true` cell with no timestamp (e.g. enabled
    /// via the configured default) is treated as "enabled now" and stamped
    /// on first read.
    func readDebugEnabled() -> Bool {
        let stored = readBool(Key.debug) ?? defaults.debug
        if !stored { return false }
        guard let enabledAt = readDouble(Key.debugEnabledAtMs) else {
            writeDouble(Key.debugEnabledAtMs, now())
            return true
        }
        if now() - enabledAt > Self.debugMaxAgeMs {
            writeBool(Key.debug, false)
            removeKey(Key.debugEnabledAtMs)
            DebugAutoOff.queueBreadcrumb()
            return false
        }
        return true
    }

    func writeDiagnosticsEnabled(_ value: Bool) {
        writeBool(Key.diagnosticsEnabled, value)
    }

    func writeApplicationUsageData(_ value: Bool) {
        writeBool(Key.applicationUsageData, value)
    }

    /// Write `debug`, stamping (true) or clearing (false) the enable
    /// timestamp synchronously. Re-writing `true` refreshes the window.
    func writeDebugEnabled(_ value: Bool) {
        writeBool(Key.debug, value)
        if value {
            writeDouble(Key.debugEnabledAtMs, now())
        } else {
            removeKey(Key.debugEnabledAtMs)
        }
    }

    enum Key {
        static let diagnosticsEnabled = "sentry.diagnosticsEnabled"
        static let applicationUsageData = "sentry.applicationUsageData"
        static let debug = "sentry.debug"
        static let debugEnabledAtMs = "sentry.debugEnabledAtMs"
    }

    /// 24h in milliseconds.
    static let debugMaxAgeMs: Double = 24 * 60 * 60 * 1000

    /// Privacy model treats baseline error visibility as on.
    static let defaultDiagnosticsEnabled: Bool = true
    /// Off until user opts in.
    static let defaultApplicationUsageData: Bool = false
    static let defaultDebug: Bool = false

    static func open() -> ComapeoPrefs {
        let sentryConfig = SentryConfig.loadFromMainBundle()
        let defaults = Defaults(
            diagnosticsEnabled: sentryConfig?.diagnosticsEnabledDefault
                ?? defaultDiagnosticsEnabled,
            applicationUsageData: sentryConfig?.applicationUsageDataDefault
                ?? defaultApplicationUsageData,
            debug: sentryConfig?.debugDefault ?? defaultDebug
        )
        let store = UserDefaults.standard
        let readBool: (String) -> Bool? = { key in
            // `object(forKey:)` distinguishes absent from explicit
            // `false`; `bool(forKey:)` collapses them, which would
            // silently re-enable diagnostics on every user `false`.
            store.object(forKey: key) as? Bool
        }
        let writeBool: (String, Bool) -> Void = { key, value in
            store.set(value, forKey: key)
        }
        let readDouble: (String) -> Double? = { key in
            store.object(forKey: key) as? Double
        }
        let writeDouble: (String, Double) -> Void = { key, value in
            store.set(value, forKey: key)
        }
        let removeKey: (String) -> Void = { key in
            store.removeObject(forKey: key)
        }

        return ComapeoPrefs(
            readBool: readBool,
            writeBool: writeBool,
            readDouble: readDouble,
            writeDouble: writeDouble,
            removeKey: removeKey,
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

/// Holds the `comapeo.debug.auto_disabled` breadcrumb queued by the 24h
/// auto-off. `readDebugEnabled()` runs before `SentrySDK.start`,
/// so the breadcrumb can't be added directly; it's drained once the SDK
/// is up.
enum DebugAutoOff {
    private static let lock = NSLock()
    private static var pendingFlag = false

    static func queueBreadcrumb() {
        lock.lock()
        pendingFlag = true
        lock.unlock()
    }

    /// Consume the pending flag; returns whether a breadcrumb is owed.
    static func consume() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        let owed = pendingFlag
        pendingFlag = false
        return owed
    }
}
