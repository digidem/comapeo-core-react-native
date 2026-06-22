import XCTest
@testable import ComapeoCore

/// Pure unit tests for `ComapeoPrefs`. Mirrors the Android
/// `ComapeoPrefsTest` JVM unit tests — same fixture cases, same
/// constructor-seam pattern. Runs in the swift-test target with no
/// simulator dependency.
///
/// Coverage rationale: this is the privacy toggle's persistence
/// layer. A regression that loses or mis-merges the default fallback
/// would either disable diagnostics on devices that should have it
/// (bug-blindness) or enable it on devices that opted out (privacy
/// regression). Both are silent if the tests don't catch them.
final class ComapeoPrefsTests: XCTestCase {

    /// Backing dictionary stand-in for the UserDefaults file. Wrapped
    /// in a class so the lambdas share mutable state with `has(_:)`.
    /// Box the dict in a reference holder so the lambdas can mutate
    /// without capturing `self` and tripping ARC's deallocation
    /// guard when the closure outlives this instance.
    private final class FakeStore {
        private final class Box {
            var bools: [String: Bool] = [:]
            var doubles: [String: Double] = [:]
        }
        private let box = Box()
        lazy var readBool: (String) -> Bool? = { [box] key in box.bools[key] }
        lazy var writeBool: (String, Bool) -> Void = { [box] key, value in
            box.bools[key] = value
        }
        lazy var readDouble: (String) -> Double? = { [box] key in box.doubles[key] }
        lazy var writeDouble: (String, Double) -> Void = { [box] key, value in
            box.doubles[key] = value
        }
        lazy var remove: (String) -> Void = { [box] key in
            box.bools[key] = nil
            box.doubles[key] = nil
        }
        func has(_ key: String) -> Bool {
            box.bools[key] != nil || box.doubles[key] != nil
        }
        func putBool(_ key: String, _ value: Bool) { box.bools[key] = value }
    }

    private final class Clock {
        var nowMs: Double = 0
    }

    private func prefs(
        store: FakeStore,
        diagnosticsDefault: Bool = ComapeoPrefs.defaultDiagnosticsEnabled,
        usageDefault: Bool = ComapeoPrefs.defaultApplicationUsageData,
        debugDefault: Bool = ComapeoPrefs.defaultDebug,
        clock: Clock = Clock()
    ) -> ComapeoPrefs {
        return ComapeoPrefs(
            readBool: store.readBool,
            writeBool: store.writeBool,
            readDouble: store.readDouble,
            writeDouble: store.writeDouble,
            removeKey: store.remove,
            defaults: ComapeoPrefs.Defaults(
                diagnosticsEnabled: diagnosticsDefault,
                applicationUsageData: usageDefault,
                debug: debugDefault
            ),
            now: { [clock] in clock.nowMs }
        )
    }

    func testBakedDefaultWhenKeyAbsent() {
        // Fresh install, plugin didn't ship a default, user hasn't
        // toggled anything — diagnostics on, usage off, debug off.
        let p = prefs(store: FakeStore())
        XCTAssertTrue(p.readDiagnosticsEnabled())
        XCTAssertFalse(p.readApplicationUsageData())
        XCTAssertFalse(p.readDebugEnabled())
    }

    func testPluginDefaultOverridesBakedWhenKeyAbsent() {
        // E.g. a dev/qa plugin config with usage on by default.
        let p = prefs(
            store: FakeStore(),
            diagnosticsDefault: false,
            usageDefault: true
        )
        XCTAssertFalse(p.readDiagnosticsEnabled())
        XCTAssertTrue(p.readApplicationUsageData())
    }

    func testUserValueWinsOverDefault() {
        // Once written, the user's choice persists across cold
        // starts regardless of what the plugin default says.
        let store = FakeStore()
        let p = prefs(store: store, diagnosticsDefault: true, usageDefault: false)
        p.writeDiagnosticsEnabled(false)
        p.writeApplicationUsageData(true)
        XCTAssertFalse(p.readDiagnosticsEnabled())
        XCTAssertTrue(p.readApplicationUsageData())
    }

    func testMigrationCopiesLegacyKeyThenDeletesIt() {
        // §11.7 one-shot rename: captureApplicationData=true present,
        // applicationUsageData absent → new key true, old key deleted.
        let store = FakeStore()
        store.putBool(ComapeoPrefs.Key.captureApplicationData, true)
        ComapeoPrefs.migrateLegacyKeys(
            readBool: store.readBool,
            writeBool: store.writeBool,
            removeKey: store.remove
        )
        XCTAssertEqual(store.readBool(ComapeoPrefs.Key.applicationUsageData), true)
        XCTAssertFalse(
            store.has(ComapeoPrefs.Key.captureApplicationData),
            "old key must be deleted after migration"
        )
    }

    func testMigrationIsNoOpWhenNewKeyAlreadySet() {
        let store = FakeStore()
        store.putBool(ComapeoPrefs.Key.captureApplicationData, true)
        store.putBool(ComapeoPrefs.Key.applicationUsageData, false)
        ComapeoPrefs.migrateLegacyKeys(
            readBool: store.readBool,
            writeBool: store.writeBool,
            removeKey: store.remove
        )
        XCTAssertEqual(store.readBool(ComapeoPrefs.Key.applicationUsageData), false)
        XCTAssertFalse(store.has(ComapeoPrefs.Key.captureApplicationData))
    }

    func testDebugAutoOffBoundaries() {
        // §11.5: fresh enable true; +23h59m true; +24h01m false + cleared.
        let store = FakeStore()
        let clock = Clock()
        clock.nowMs = 1_000_000
        let p = prefs(store: store, clock: clock)
        p.writeDebugEnabled(true)
        XCTAssertTrue(p.readDebugEnabled(), "fresh enable reads true")

        clock.nowMs += ComapeoPrefs.debugMaxAgeMs - 60_000 // +23h59m
        XCTAssertTrue(p.readDebugEnabled(), "within 24h reads true")

        clock.nowMs += 120_000 // now past 24h since enable
        XCTAssertFalse(p.readDebugEnabled(), "past 24h auto-disables")
        XCTAssertEqual(
            store.readBool(ComapeoPrefs.Key.debug), false,
            "auto-off clears the value"
        )
        XCTAssertFalse(
            store.has(ComapeoPrefs.Key.debugEnabledAtMs),
            "auto-off clears the timestamp"
        )
        XCTAssertFalse(p.readDebugEnabled(), "subsequent read is stable")
    }

    func testDebugReEnableRefreshesWindow() {
        let store = FakeStore()
        let clock = Clock()
        let p = prefs(store: store, clock: clock)
        p.writeDebugEnabled(true)
        clock.nowMs += ComapeoPrefs.debugMaxAgeMs - 60_000
        p.writeDebugEnabled(true) // refresh at 23h59m
        clock.nowMs += ComapeoPrefs.debugMaxAgeMs - 60_000
        XCTAssertTrue(p.readDebugEnabled(), "re-enable should reset the 24h clock")
    }

    func testDebugTrueWithoutTimestampStampsAndStaysOn() {
        let store = FakeStore()
        store.putBool(ComapeoPrefs.Key.debug, true)
        let clock = Clock()
        clock.nowMs = 500
        let p = prefs(store: store, clock: clock)
        XCTAssertTrue(p.readDebugEnabled())
        XCTAssertEqual(store.readDouble(ComapeoPrefs.Key.debugEnabledAtMs), 500)
    }

    func testWriteFalsePersistsExplicitlyNotJustClears() {
        // Defensive: a regression that "clears the key on write false"
        // would silently re-enable diagnostics by falling back to the
        // baked-in default. The key must be present with `false`.
        let store = FakeStore()
        let p = prefs(store: store, diagnosticsDefault: true)
        p.writeDiagnosticsEnabled(false)
        XCTAssertTrue(
            store.has(ComapeoPrefs.Key.diagnosticsEnabled),
            "false write must persist the key, not delete it"
        )
        XCTAssertFalse(p.readDiagnosticsEnabled())
    }

    func testKeysArePinned() {
        // Pin the storage key names so we don't accidentally rename
        // them in a future refactor (which would orphan every user's
        // saved choice on update).
        XCTAssertEqual(
            ComapeoPrefs.Key.diagnosticsEnabled,
            "sentry.diagnosticsEnabled"
        )
        XCTAssertEqual(
            ComapeoPrefs.Key.applicationUsageData,
            "sentry.applicationUsageData"
        )
        XCTAssertEqual(
            ComapeoPrefs.Key.captureApplicationData,
            "sentry.captureApplicationData"
        )
        XCTAssertEqual(ComapeoPrefs.Key.debug, "sentry.debug")
    }

    func testWipeSentryOutboxRemovesDirectory() throws {
        // Privacy-load-bearing: a regression that silently no-ops
        // this delete (wrong path constant, swallowed FileManager
        // error, etc.) would leave queued events on disk that the
        // next launch would re-ship even though the user opted out.
        let fm = FileManager.default
        let tempRoot = fm.temporaryDirectory
            .appendingPathComponent("comapeo-prefs-test-\(UUID().uuidString)")
        let sentryDir = tempRoot.appendingPathComponent("io.sentry")
        try fm.createDirectory(
            at: sentryDir.appendingPathComponent("envelopes"),
            withIntermediateDirectories: true
        )
        try "payload".write(
            to: sentryDir.appendingPathComponent("envelopes/123.envelope"),
            atomically: true,
            encoding: .utf8
        )
        try fm.createDirectory(
            at: sentryDir.appendingPathComponent("sessions"),
            withIntermediateDirectories: true
        )
        XCTAssertTrue(fm.fileExists(atPath: sentryDir.path))

        ComapeoPrefs.wipeSentryOutbox(at: sentryDir)

        XCTAssertFalse(
            fm.fileExists(atPath: sentryDir.path),
            "wipe must recursively remove the sentry dir"
        )
        // Clean up the temp root (parent of sentryDir).
        try? fm.removeItem(at: tempRoot)
    }

    func testWipeSentryOutboxIsNoOpWhenAbsent() {
        // First-run / already-wiped path: a missing directory is
        // success, not an error. The KDoc promises "best-effort" —
        // verify that absence doesn't throw.
        let missing = FileManager.default.temporaryDirectory
            .appendingPathComponent("comapeo-missing-\(UUID().uuidString)/io.sentry")
        XCTAssertFalse(FileManager.default.fileExists(atPath: missing.path))
        ComapeoPrefs.wipeSentryOutbox(at: missing) // must not throw
        XCTAssertFalse(FileManager.default.fileExists(atPath: missing.path))
    }
}
