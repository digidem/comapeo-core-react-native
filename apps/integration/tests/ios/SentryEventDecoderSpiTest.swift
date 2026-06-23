import XCTest

// `SentryEventDecoder.decodeEvent(jsonData:)` is marked `@_spi(Private)`
// in sentry-cocoa — Sentry's "hybrid-SDK only, may rename in future
// minors" tag. We rely on it in `SentryNativeBridge.captureEventJson`
// to deserialise Node-emitted events. If sentry-cocoa removes or
// renames the symbol on a future bump, the SDK build still succeeds
// (it's only a no-op when `canImport(Sentry)` is true but the symbol
// is gone via different reasons), but the forwarding silently breaks.
// This test catches a removal at compile time (the file fails to build
// when the symbol disappears) and a behavioural regression at run
// time (decoder returns nil for a known-good payload).
@_spi(Private) import Sentry

/// Regression test for the `@_spi(Private)` sentry-cocoa symbol we
/// depend on. Lives in the example app's test target — that's where
/// the real `Sentry` pod is linked. The Swift Package target in
/// `ios/` doesn't include Sentry, so a unit test there would compile
/// past a missing symbol.
final class SentryEventDecoderSpiTest: XCTestCase {

    func testDecodeEventFromKnownGoodJson() throws {
        // Minimal payload covering the load-bearing fields the
        // forwarding path produces. Same shape `@sentry/node`'s event
        // capture emits — event_id (32 hex chars), timestamp (epoch
        // seconds), platform, level, exception with one frame.
        let json = #"""
        {
          "event_id": "0123456789abcdef0123456789abcdef",
          "timestamp": 1715562000.0,
          "platform": "node",
          "level": "error",
          "exception": {
            "values": [{
              "type": "Error",
              "value": "smoke",
              "stacktrace": {
                "frames": [{
                  "filename": "app.js",
                  "function": "main",
                  "lineno": 1
                }]
              }
            }]
          }
        }
        """#

        guard let data = json.data(using: .utf8) else {
            return XCTFail("test fixture is not valid UTF-8")
        }
        let event = SentryEventDecoder.decodeEvent(jsonData: data)
        XCTAssertNotNil(
            event,
            "SentryEventDecoder.decodeEvent returned nil for a known-good payload. "
            + "If sentry-cocoa renamed or removed the SPI'd symbol, "
            + "SentryNativeBridge.captureEventJson is broken — see plan-doc §5.7."
        )
        XCTAssertEqual(event?.level, .error)
        XCTAssertEqual(event?.platform, "node")
        XCTAssertEqual(event?.exceptions?.first?.value, "smoke")
    }
}
