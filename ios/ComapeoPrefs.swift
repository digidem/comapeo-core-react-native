import Foundation

/// Persistent storage for sentry-related user preferences. Snapshot-
/// at-launch: toggle changes take effect on next launch; flipping a
/// toggle to `false` also wipes the sentry-cocoa cache so queued events
/// don't ship. Mirrors `ComapeoPrefs.kt`.
///
/// Persistence goes through a `Store` so unit tests can back it with a
/// plain dictionary instead of a real `UserDefaults`.
final class ComapeoPrefs {
    /// Minimal persistence surface. `nil` from a getter means "key
    /// absent" (so the caller falls back to a default). Production wraps
    /// `UserDefaults`; tests use an in-memory dictionary.
    protocol Store {
        func getBool(_ key: String) -> Bool?
        func setBool(_ key: String, _ value: Bool)
        func getDouble(_ key: String) -> Double?
        func setDouble(_ key: String, _ value: Double)
        func getString(_ key: String) -> String?
        func setString(_ key: String, _ value: String)
        func remove(_ key: String)
    }

    struct Defaults {
        let diagnosticsEnabled: Bool
        let applicationUsageData: Bool
        let debug: Bool
    }

    private let store: Store
    private let defaults: Defaults
    /// Wall clock; injectable so the debug-auto-off tests don't depend on real time.
    private let now: () -> Double

    init(
        store: Store,
        defaults: Defaults,
        now: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 }
    ) {
        self.store = store
        self.defaults = defaults
        self.now = now
    }

    func readDiagnosticsEnabled() -> Bool {
        store.getBool(Key.diagnosticsEnabled) ?? defaults.diagnosticsEnabled
    }

    func readApplicationUsageData() -> Bool {
        store.getBool(Key.applicationUsageData) ?? defaults.applicationUsageData
    }

    /// Raw stored `debug` value with no auto-off side effect — the user's saved
    /// toggle for a live settings read. `readDebugEnabled()` applies the 72h
    /// auto-off (and its disk mutation) at launch; this must not, so a getter
    /// never writes.
    func readDebugStored() -> Bool {
        store.getBool(Key.debug) ?? defaults.debug
    }

    /// Read the `debug` toggle, applying the `debugMaxAgeMs` auto-off: if
    /// debug was switched on longer ago than that, flip it off, clear the
    /// timestamp, queue a `comapeo.debug.auto_disabled` breadcrumb, and
    /// return `false`. A `debug=true` cell with no timestamp (e.g. enabled
    /// via the configured default) is treated as "enabled now" and stamped
    /// on first read.
    ///
    /// The window is wall-clock based (it must survive process restarts),
    /// so a backward clock change is treated conservatively: an enable
    /// timestamp in the future expires debug rather than extending it. This
    /// is a best-effort privacy window on the user's own device, not a
    /// security boundary.
    func readDebugEnabled() -> Bool {
        let stored = store.getBool(Key.debug) ?? defaults.debug
        if !stored { return false }
        guard let enabledAt = store.getDouble(Key.debugEnabledAtMs) else {
            store.setDouble(Key.debugEnabledAtMs, now())
            return true
        }
        let age = now() - enabledAt
        if age < 0 || age > Self.debugMaxAgeMs {
            store.setBool(Key.debug, false)
            store.remove(Key.debugEnabledAtMs)
            DebugAutoOff.queueBreadcrumb()
            return false
        }
        return true
    }

    func writeDiagnosticsEnabled(_ value: Bool) {
        store.setBool(Key.diagnosticsEnabled, value)
    }

    func writeApplicationUsageData(_ value: Bool) {
        store.setBool(Key.applicationUsageData, value)
    }

    /// The permanent per-install root user ID (a short `XXXX-XXXX-XXXX`
    /// code — see `SentryUserId.generateRootId`), generated lazily on first
    /// read. Never sent to Sentry — Sentry `user.id` values are derived from
    /// it via `SentryUserId.derive`. Exposed to the host app (via
    /// `getSentryRootUserId`) so a user can share it for debugging and we can
    /// recompute their historical monthly IDs. Lives in `UserDefaults` (not
    /// Keychain) deliberately: uninstall should genuinely reset identity.
    func readRootUserId() -> String {
        if let existing = store.getString(Key.rootUserId) { return existing }
        let generated = SentryUserId.generateRootId()
        store.setString(Key.rootUserId, generated)
        return generated
    }

    /// The Sentry `user.id` for this launch: permanent when the user opted
    /// in to application-usage data, otherwise rotating monthly (UTC).
    func deriveSentryUserId(applicationUsageData: Bool) -> String {
        SentryUserId.derive(
            rootUserId: readRootUserId(),
            permanent: applicationUsageData,
            nowMs: now()
        )
    }

    /// Write `debug`, stamping (true) or clearing (false) the enable
    /// timestamp synchronously. Re-writing `true` refreshes the window.
    func writeDebugEnabled(_ value: Bool) {
        store.setBool(Key.debug, value)
        if value {
            store.setDouble(Key.debugEnabledAtMs, now())
        } else {
            store.remove(Key.debugEnabledAtMs)
        }
    }

    enum Key {
        static let diagnosticsEnabled = "sentry.diagnosticsEnabled"
        static let applicationUsageData = "sentry.applicationUsageData"
        static let debug = "sentry.debug"
        static let debugEnabledAtMs = "sentry.debugEnabledAtMs"
        static let rootUserId = "sentry.rootUserId"
    }

    /// 72h in milliseconds — debug mode auto-disables this long after enable.
    static let debugMaxAgeMs: Double = 72 * 60 * 60 * 1000

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
        return ComapeoPrefs(
            store: UserDefaultsStore(defaults: UserDefaults.standard),
            defaults: defaults
        )
    }

    /// `UserDefaults`-backed [Store]. `object(forKey:)` distinguishes absent
    /// from an explicit `false`; `bool(forKey:)` collapses them, which would
    /// silently re-enable diagnostics on every user `false`.
    private struct UserDefaultsStore: Store {
        let defaults: UserDefaults
        func getBool(_ key: String) -> Bool? { defaults.object(forKey: key) as? Bool }
        func setBool(_ key: String, _ value: Bool) { defaults.set(value, forKey: key) }
        func getDouble(_ key: String) -> Double? { defaults.object(forKey: key) as? Double }
        func setDouble(_ key: String, _ value: Double) { defaults.set(value, forKey: key) }
        func getString(_ key: String) -> String? { defaults.string(forKey: key) }
        func setString(_ key: String, _ value: String) { defaults.set(value, forKey: key) }
        func remove(_ key: String) { defaults.removeObject(forKey: key) }
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

/// Holds the `comapeo.debug.auto_disabled` breadcrumb queued by the debug
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
