import XCTest
@testable import ComapeoCore

/// Pinned vectors for the user.id derivation. The same vectors live in
/// `SentryUserIdTest.kt` — both platforms must derive identical IDs
/// from identical inputs so support can recompute a user's historical
/// monthly IDs from a shared root ID regardless of platform.
///
/// Vectors are `sha256("<root>|<salt>")` hex, first 16 chars.
final class SentryUserIdTests: XCTestCase {

    // 2026-07-01T00:00:00Z
    private let july2026Ms: Double = 1_782_864_000_000

    func testMonthlyVector() {
        XCTAssertEqual(
            "e15e7255ae360358",
            SentryUserId.derive(rootUserId: "test-root", permanent: false, nowMs: july2026Ms)
        )
    }

    func testPermanentVector() {
        XCTAssertEqual(
            "cbd8388dc87b1a9c",
            SentryUserId.derive(rootUserId: "test-root", permanent: true, nowMs: july2026Ms)
        )
    }

    func testGenerateRootIdFormat() {
        // XXXX-XXXX-XXXX from the no-I/L/O/U alphabet — a user must be able
        // to hand-copy this from a screen without ambiguous characters.
        let format = "^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$"
        for _ in 0..<20 {
            let id = SentryUserId.generateRootId()
            XCTAssertNotNil(
                id.range(of: format, options: .regularExpression),
                "bad root id format: \(id)"
            )
        }
        XCTAssertNotEqual(SentryUserId.generateRootId(), SentryUserId.generateRootId())
    }

    func testUtcYearMonthPadsAndUsesUtc() {
        XCTAssertEqual("1970-01", SentryUserId.utcYearMonth(nowMs: 0))
        // 1ms before the month boundary vs 1ms after — the rotation
        // boundary is UTC midnight, not device-local.
        let feb1970Ms: Double = 31 * 24 * 60 * 60 * 1000
        XCTAssertEqual("1970-01", SentryUserId.utcYearMonth(nowMs: feb1970Ms - 1))
        XCTAssertEqual("1970-02", SentryUserId.utcYearMonth(nowMs: feb1970Ms))
        XCTAssertEqual("2026-07", SentryUserId.utcYearMonth(nowMs: july2026Ms))
    }
}
