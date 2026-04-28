import Foundation
import Security

/// Persistent store for the 16-byte CoMapeo rootkey on iOS.
///
/// The rootkey is the device's identity in every CoMapeo project it
/// participates in. It is generated once on first launch and never rotated —
/// regenerating produces a new device identity, which is identity loss.
///
/// Storage:
///   - `kSecClassGenericPassword` keychain item.
///   - `kSecAttrService = <bundle id>` (or a fixed fallback if the bundle id
///     is unavailable, e.g. under `swift test`).
///   - `kSecAttrAccount = "rootkey.v1"`.
///   - `kSecAttrAccessible = AfterFirstUnlockThisDeviceOnly` — readable in
///     the background once the user has unlocked at least once since reboot,
///     never iCloud-migrated, never device-to-device-restored.
///   - No biometrics, no user-presence flags.
///   - Value: raw 16 bytes. The keychain encrypts transparently.
final class RootKeyStore {
    enum RootKeyError: Error, LocalizedError {
        case interactionNotAllowed
        case unexpectedKeychainError(OSStatus)
        case wrongLength(Int)
        case randomGenerationFailed(Int32)

        var errorDescription: String? {
            switch self {
            case .interactionNotAllowed:
                return "Keychain not yet available (device locked since reboot)"
            case .unexpectedKeychainError(let status):
                return "Keychain error: OSStatus \(status)"
            case .wrongLength(let n):
                return "Stored rootkey has wrong length: \(n) bytes (expected 16)"
            case .randomGenerationFailed(let status):
                return "SecRandomCopyBytes failed: \(status)"
            }
        }
    }

    static let rootKeyByteLength = 16
    static let account = "rootkey.v1"

    private let service: String

    init(service: String? = nil) {
        // Fall back to a stable identifier if no bundle id is available
        // (e.g. macOS unit-test process). Production callers always have a
        // bundle id, so this only matters for ad-hoc tooling.
        self.service = service
            ?? Bundle.main.bundleIdentifier
            ?? "com.comapeo.core"
    }

    /// Returns the 16-byte rootkey, generating and persisting it on first
    /// launch. Throws if the keychain is unavailable (device locked since
    /// reboot) or if a stored entry has the wrong length — never silently
    /// regenerates on read failure.
    func loadOrInitialize() throws -> Data {
        if let existing = try load() { return existing }
        let fresh = try generate()
        try store(fresh)
        return fresh
    }

    private func load() throws -> Data? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        switch status {
        case errSecSuccess:
            guard let data = item as? Data else {
                throw RootKeyError.unexpectedKeychainError(status)
            }
            guard data.count == RootKeyStore.rootKeyByteLength else {
                throw RootKeyError.wrongLength(data.count)
            }
            return data
        case errSecItemNotFound:
            return nil
        case errSecInteractionNotAllowed:
            throw RootKeyError.interactionNotAllowed
        default:
            throw RootKeyError.unexpectedKeychainError(status)
        }
    }

    private func store(_ key: Data) throws {
        var attributes = baseQuery()
        attributes[kSecValueData as String] = key
        attributes[kSecAttrAccessible as String] =
            kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

        let status = SecItemAdd(attributes as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw RootKeyError.unexpectedKeychainError(status)
        }
    }

    private func generate() throws -> Data {
        var bytes = Data(count: RootKeyStore.rootKeyByteLength)
        let status: Int32 = bytes.withUnsafeMutableBytes { rawBuf in
            guard let baseAddress = rawBuf.baseAddress else { return errSecAllocate }
            return SecRandomCopyBytes(
                kSecRandomDefault,
                RootKeyStore.rootKeyByteLength,
                baseAddress
            )
        }
        guard status == errSecSuccess else {
            throw RootKeyError.randomGenerationFailed(status)
        }
        return bytes
    }

    private func baseQuery() -> [String: Any] {
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: RootKeyStore.account,
        ]
    }
}
