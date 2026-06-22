import XCTest
@testable import ComapeoCore

/// Pure unit tests for `SentryConfig.load`. Mirrors the Android
/// `SentryConfigTest` JVM unit tests — same fixture cases, same
/// pure-getter pattern. Runs as part of the swift-test target with
/// no simulator dependency.
///
/// Coverage rationale: this is the deserialization seam between the
/// Expo plugin's plist writes and the native consumers (SDK init,
/// argv flags). A regression here would silently disable Sentry or
/// ship the wrong environment tag — both of which produce useless
/// Sentry projects rather than visible failures.
final class SentryConfigTests: XCTestCase {

    private let defaultRelease: () -> String = { "1.2.3+42" }

    func testReturnsNilWhenDsnMissing() {
        // Mirrors the "plugin not registered, or registered without
        // a sentry argument" case: no plist keys were written, so
        // loading produces nil — the documented "Sentry off" state.
        let config = SentryConfig.load(from: [:], defaultRelease: defaultRelease)
        XCTAssertNil(config)
    }

    func testReturnsNilWhenDsnEmptyString() {
        // Defensive: a plist round-trip can produce an empty-string
        // key. Treat that the same as absent.
        let config = SentryConfig.load(
            from: [SentryConfig.Key.dsn: ""],
            defaultRelease: defaultRelease
        )
        XCTAssertNil(config)
    }

    func testLoadsRequiredFields() {
        let config = SentryConfig.load(
            from: [
                SentryConfig.Key.dsn: "https://abc@sentry.example/1",
                SentryConfig.Key.environment: "production",
            ],
            defaultRelease: defaultRelease
        )
        XCTAssertNotNil(config)
        XCTAssertEqual(config?.dsn, "https://abc@sentry.example/1")
        XCTAssertEqual(config?.environment, "production")
        XCTAssertEqual(config?.release, "1.2.3+42")
        XCTAssertNil(config?.sampleRate)
        XCTAssertNil(config?.tracesSampleRate)
        XCTAssertNil(config?.rpcArgsBytes)
        XCTAssertNil(config?.diagnosticsEnabledDefault)
        XCTAssertNil(config?.applicationUsageDataDefault)
        XCTAssertNil(config?.debugDefault)
    }

    func testPluginReleaseOverridesDefault() {
        // When the consumer passes `release` to the plugin, that
        // value wins over CFBundleShortVersionString+CFBundleVersion.
        // Used to embed git SHAs from EAS_BUILD_GIT_COMMIT_HASH
        // (plan §4.1).
        let config = SentryConfig.load(
            from: [
                SentryConfig.Key.dsn: "https://x@sentry.io/1",
                SentryConfig.Key.environment: "qa",
                SentryConfig.Key.release: "deadbeef",
            ],
            defaultRelease: defaultRelease
        )
        XCTAssertEqual(config?.release, "deadbeef")
    }

    func testParsesNumericStringFields() {
        let config = SentryConfig.load(
            from: [
                SentryConfig.Key.dsn: "https://x@sentry.io/1",
                SentryConfig.Key.environment: "production",
                SentryConfig.Key.sampleRate: "0.5",
                SentryConfig.Key.tracesSampleRate: "0.1",
                SentryConfig.Key.rpcArgsBytes: "0",
            ],
            defaultRelease: defaultRelease
        )
        XCTAssertEqual(config?.sampleRate, 0.5)
        XCTAssertEqual(config?.tracesSampleRate, 0.1)
        XCTAssertEqual(config?.rpcArgsBytes, 0)
    }

    func testParsesNumericNativePlistTypes() {
        // The plugin coerces values to strings, but a hand-written
        // plist may use native plist types (real <real>/<integer>).
        // Accept both so a developer hand-editing for a one-off
        // build doesn't have to remember to quote.
        let config = SentryConfig.load(
            from: [
                SentryConfig.Key.dsn: "https://x@sentry.io/1",
                SentryConfig.Key.environment: "production",
                SentryConfig.Key.sampleRate: 0.5,
                SentryConfig.Key.rpcArgsBytes: 0,
            ],
            defaultRelease: defaultRelease
        )
        XCTAssertEqual(config?.sampleRate, 0.5)
        XCTAssertEqual(config?.rpcArgsBytes, 0)
    }

    func testUnparseableNumericFieldsAreNil() {
        // The plugin coerces values to strings on the way in; if a
        // future plugin bug or a hand-edited plist produces an
        // unparseable value, we'd rather drop the field than crash.
        let config = SentryConfig.load(
            from: [
                SentryConfig.Key.dsn: "https://x@sentry.io/1",
                SentryConfig.Key.environment: "production",
                SentryConfig.Key.sampleRate: "not-a-number",
                SentryConfig.Key.rpcArgsBytes: "1.5",
            ],
            defaultRelease: defaultRelease
        )
        XCTAssertNil(config?.sampleRate)
        XCTAssertNil(config?.rpcArgsBytes)
    }

    func testDiagnosticsEnabledDefaultParses() {
        let on = SentryConfig.load(
            from: [
                SentryConfig.Key.dsn: "https://x@sentry.io/1",
                SentryConfig.Key.environment: "qa",
                SentryConfig.Key.diagnosticsEnabledDefault: "true",
            ],
            defaultRelease: defaultRelease
        )
        XCTAssertEqual(on?.diagnosticsEnabledDefault, true)

        let off = SentryConfig.load(
            from: [
                SentryConfig.Key.dsn: "https://x@sentry.io/1",
                SentryConfig.Key.environment: "production",
                // String "false" mirrors the Android JVM unit-test
                // fixture and exercises the same `parseStrictBool`
                // string branch the plugin actually emits at prebuild
                // — the manifest meta-data is string-typed on Android
                // and the plugin coerces values to strings here too
                // (see `app.plugin.js`'s `normalizeSentryProps`).
                SentryConfig.Key.diagnosticsEnabledDefault: "false",
            ],
            defaultRelease: defaultRelease
        )
        XCTAssertEqual(off?.diagnosticsEnabledDefault, false)

        // Strict parse: "yes" → nil; ComapeoPrefs falls back to the
        // baked-in default (diagnostics on).
        let stray = SentryConfig.load(
            from: [
                SentryConfig.Key.dsn: "https://x@sentry.io/1",
                SentryConfig.Key.environment: "qa",
                SentryConfig.Key.diagnosticsEnabledDefault: "yes",
            ],
            defaultRelease: defaultRelease
        )
        XCTAssertNil(stray?.diagnosticsEnabledDefault)
    }

    func testApplicationUsageDataDefaultParsesString() {
        let on = SentryConfig.load(
            from: [
                SentryConfig.Key.dsn: "https://x@sentry.io/1",
                SentryConfig.Key.environment: "qa",
                SentryConfig.Key.applicationUsageDataDefault: "true",
            ],
            defaultRelease: defaultRelease
        )
        XCTAssertEqual(on?.applicationUsageDataDefault, true)

        let off = SentryConfig.load(
            from: [
                SentryConfig.Key.dsn: "https://x@sentry.io/1",
                SentryConfig.Key.environment: "production",
                SentryConfig.Key.applicationUsageDataDefault: "false",
            ],
            defaultRelease: defaultRelease
        )
        XCTAssertEqual(off?.applicationUsageDataDefault, false)
    }

    func testDeprecatedCaptureApplicationDataDefaultStillReadAsUsage() {
        // §11.7: the old plist key feeds the new field for one minor.
        let config = SentryConfig.load(
            from: [
                SentryConfig.Key.dsn: "https://x@sentry.io/1",
                SentryConfig.Key.environment: "production",
                SentryConfig.Key.captureApplicationDataDefault: true,
            ],
            defaultRelease: defaultRelease
        )
        XCTAssertEqual(config?.applicationUsageDataDefault, true)
    }

    func testDebugDefaultParses() {
        let config = SentryConfig.load(
            from: [
                SentryConfig.Key.dsn: "https://x@sentry.io/1",
                SentryConfig.Key.environment: "qa",
                SentryConfig.Key.debugDefault: "true",
            ],
            defaultRelease: defaultRelease
        )
        XCTAssertEqual(config?.debugDefault, true)
    }

    func testApplicationUsageDataDefaultStrictness() {
        // Only "true"/"false" (or a real Bool) parse. A stray
        // "1"/"yes" returns nil → native treats absence as false.
        // Defensive against hand-written plists silently flipping
        // the default.
        let config = SentryConfig.load(
            from: [
                SentryConfig.Key.dsn: "https://x@sentry.io/1",
                SentryConfig.Key.environment: "qa",
                SentryConfig.Key.applicationUsageDataDefault: "yes",
            ],
            defaultRelease: defaultRelease
        )
        XCTAssertNil(config?.applicationUsageDataDefault)
    }

    func testMissingEnvironmentReturnsNilNotFatal() {
        // The plugin refuses to prebuild without environment (§4.1),
        // but a stale prebuild from before that validation was added
        // would still ship. The original `fatalError` behaviour
        // crashed every cold start with no way to recover. Now we
        // log loud and return nil (Sentry off) so the host app
        // keeps running; the misconfiguration becomes visible the
        // next time someone re-runs `expo prebuild`.
        let config = SentryConfig.load(
            from: [SentryConfig.Key.dsn: "https://x@sentry.io/1"],
            defaultRelease: defaultRelease
        )
        XCTAssertNil(config, "DSN-without-environment should disable Sentry rather than crash")
    }
}
