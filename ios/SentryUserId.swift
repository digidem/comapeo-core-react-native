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

    /// Crockford-style base32: no I/L/O/U, so a root ID read off a screen
    /// and typed back by hand can't be mis-transcribed. Must match
    /// `SentryUserId.kt`.
    static let rootIdAlphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")

    /// A fresh root user ID: 12 alphabet chars grouped `XXXX-XXXX-XXXX`
    /// (60 bits — comfortable headroom against collisions across the
    /// install base while staying short enough to copy from a screen by
    /// hand). Stored and hashed exactly as formatted, hyphens included.
    static func generateRootId() -> String {
        var rng = SystemRandomNumberGenerator()
        let chars = (0..<12).map { _ in
            rootIdAlphabet[Int(rng.next(upperBound: UInt32(rootIdAlphabet.count)))]
        }
        return [chars[0..<4], chars[4..<8], chars[8..<12]]
            .map { String($0) }
            .joined(separator: "-")
    }

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
