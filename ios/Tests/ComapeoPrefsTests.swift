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

    /// In-memory `ComapeoPrefs.Store` stand-in for the UserDefaults file.
    private final class FakeStore: ComapeoPrefs.Store {
        private var bools: [String: Bool] = [:]
        private var doubles: [String: Double] = [:]
        func getBool(_ key: String) -> Bool? { bools[key] }
        func setBool(_ key: String, _ value: Bool) { bools[key] = value }
        func getDouble(_ key: String) -> Double? { doubles[key] }
        func setDouble(_ key: String, _ value: Double) { doubles[key] = value }
        func remove(_ key: String) { bools[key] = nil; doubles[key] = nil }
        func has(_ key: String) -> Bool {
            bools[key] != nil || doubles[key] != nil
        }
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
            store: store,
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

    func testDebugAutoOffBoundaries() {
        // fresh enable true; just within window true; just past window false + cleared.
        let store = FakeStore()
        let clock = Clock()
        clock.nowMs = 1_000_000
        let p = prefs(store: store, clock: clock)
        p.writeDebugEnabled(true)
        XCTAssertTrue(p.readDebugEnabled(), "fresh enable reads true")

        clock.nowMs += ComapeoPrefs.debugMaxAgeMs - 60_000 // one minute before expiry
        XCTAssertTrue(p.readDebugEnabled(), "within window reads true")

        clock.nowMs += 120_000 // now past the window since enable
        XCTAssertFalse(p.readDebugEnabled(), "past window auto-disables")
        XCTAssertEqual(
            store.getBool(ComapeoPrefs.Key.debug), false,
            "auto-off clears the value"
        )
        XCTAssertFalse(
            store.has(ComapeoPrefs.Key.debugEnabledAtMs),
            "auto-off clears the timestamp"
        )
        XCTAssertFalse(p.readDebugEnabled(), "subsequent read is stable")
    }

    func testDebugExpiresWhenClockMovesBackwardPastEnable() {
        // Backward wall-clock change must not extend debug: an enable
        // timestamp in the future (age < 0) auto-disables rather than
        // keeping debug on indefinitely.
        let store = FakeStore()
        let clock = Clock()
        clock.nowMs = 10_000_000
        let p = prefs(store: store, clock: clock)
        p.writeDebugEnabled(true)
        XCTAssertTrue(p.readDebugEnabled())

        clock.nowMs -= 5_000_000 // clock moved back before the enable stamp
        XCTAssertFalse(p.readDebugEnabled(), "backward clock past enable auto-disables")
        XCTAssertFalse(store.has(ComapeoPrefs.Key.debugEnabledAtMs))
    }

    func testDebugReEnableRefreshesWindow() {
        let store = FakeStore()
        let clock = Clock()
        let p = prefs(store: store, clock: clock)
        p.writeDebugEnabled(true)
        clock.nowMs += ComapeoPrefs.debugMaxAgeMs - 60_000
        p.writeDebugEnabled(true) // refresh just before expiry
        clock.nowMs += ComapeoPrefs.debugMaxAgeMs - 60_000
        XCTAssertTrue(p.readDebugEnabled(), "re-enable should reset the window clock")
    }

    func testReadDebugStoredIsRawWithNoAutoOff() {
        // The live settings read must return the raw saved toggle and never
        // mutate: past the window, readDebugEnabled auto-disables + writes,
        // but readDebugStored still reads true and leaves disk untouched.
        let store = FakeStore()
        let clock = Clock()
        clock.nowMs = 1_000
        let p = prefs(store: store, clock: clock)
        p.writeDebugEnabled(true)
        clock.nowMs += ComapeoPrefs.debugMaxAgeMs + 60_000

        XCTAssertTrue(p.readDebugStored(), "raw read returns stored value")
        XCTAssertEqual(
            store.getBool(ComapeoPrefs.Key.debug), true,
            "raw read does not clear the stored value"
        )
        XCTAssertTrue(
            store.has(ComapeoPrefs.Key.debugEnabledAtMs),
            "raw read runs no auto-off (timestamp intact)"
        )
    }

    func testDebugTrueWithoutTimestampStampsAndStaysOn() {
        let store = FakeStore()
        store.setBool(ComapeoPrefs.Key.debug, true)
        let clock = Clock()
        clock.nowMs = 500
        let p = prefs(store: store, clock: clock)
        XCTAssertTrue(p.readDebugEnabled())
        XCTAssertEqual(store.getDouble(ComapeoPrefs.Key.debugEnabledAtMs), 500)
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
