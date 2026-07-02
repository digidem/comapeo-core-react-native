import CryptoKit
import Foundation

/// Derives the Sentry `user.id` from the permanent per-install root user ID
/// (see `ComapeoPrefs.readRootUserId`). The root ID itself never leaves the
/// device; Sentry only ever sees a truncated hash:
///
/// - usage opt-in **off** → `sha256("<root>|<YYYY-MM UTC>")` — rotates each
///   UTC month so cross-month events can't be linked to one install;
/// - usage opt-in **on** → `sha256("<root>|permanent")` — stable across
///   launches and months so cohort analysis works.
///
/// Both are recoverable from a user-shared root ID, so historical events can
/// be re-associated for a support case. Must stay in lock-step with
/// `SentryUserId.kt` (shared test vectors in both suites).
enum SentryUserId {
    static let permanentSalt = "permanent"
    private static let idLength = 16

    static func derive(rootUserId: String, permanent: Bool, nowMs: Double) -> String {
        let salt = permanent ? permanentSalt : utcYearMonth(nowMs: nowMs)
        return String(sha256Hex("\(rootUserId)|\(salt)").prefix(idLength))
    }

    /// `YYYY-MM` in UTC.
    static func utcYearMonth(nowMs: Double) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let date = Date(timeIntervalSince1970: nowMs / 1000)
        let parts = calendar.dateComponents([.year, .month], from: date)
        return String(format: "%04d-%02d", parts.year!, parts.month!)
    }

    private static func sha256Hex(_ input: String) -> String {
        SHA256.hash(data: Data(input.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
    }
}
