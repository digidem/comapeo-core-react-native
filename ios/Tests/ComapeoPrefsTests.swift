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
            var data: [String: Bool] = [:]
        }
        private let box = Box()
        lazy var read: (String) -> Bool? = { [box] key in box.data[key] }
        lazy var write: (String, Bool) -> Void = { [box] key, value in
            box.data[key] = value
        }
        func has(_ key: String) -> Bool { return box.data[key] != nil }
    }

    private func prefs(
        store: FakeStore,
        diagnosticsDefault: Bool = ComapeoPrefs.defaultDiagnosticsEnabled,
        captureDefault: Bool = ComapeoPrefs.defaultCaptureApplicationData
    ) -> ComapeoPrefs {
        return ComapeoPrefs(
            readBool: store.read,
            writeBool: store.write,
            defaults: ComapeoPrefs.Defaults(
                diagnosticsEnabled: diagnosticsDefault,
                captureApplicationData: captureDefault
            )
        )
    }

    func testBakedDefaultWhenKeyAbsent() {
        // Fresh install, plugin didn't ship a default, user hasn't
        // toggled anything — diagnostics on, capture-app-data off.
        let p = prefs(store: FakeStore())
        XCTAssertTrue(p.readDiagnosticsEnabled())
        XCTAssertFalse(p.readCaptureApplicationData())
    }

    func testPluginDefaultOverridesBakedWhenKeyAbsent() {
        // E.g. a dev/qa plugin config with both flags on by default.
        let p = prefs(
            store: FakeStore(),
            diagnosticsDefault: false,
            captureDefault: true
        )
        XCTAssertFalse(p.readDiagnosticsEnabled())
        XCTAssertTrue(p.readCaptureApplicationData())
    }

    func testUserValueWinsOverDefault() {
        // Once written, the user's choice persists across cold
        // starts regardless of what the plugin default says.
        let store = FakeStore()
        let p = prefs(store: store, diagnosticsDefault: true, captureDefault: false)
        p.writeDiagnosticsEnabled(false)
        p.writeCaptureApplicationData(true)
        XCTAssertFalse(p.readDiagnosticsEnabled())
        XCTAssertTrue(p.readCaptureApplicationData())
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
            ComapeoPrefs.Key.captureApplicationData,
            "sentry.captureApplicationData"
        )
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
