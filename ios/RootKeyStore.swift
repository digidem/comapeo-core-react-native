import Foundation
import Security

/// Persistent store for the 16-byte CoMapeo rootkey.
///
/// The rootkey is the device's identity across every CoMapeo project.
/// Generated once on first launch and never rotated — regenerating
/// produces a new device identity (identity loss).
///
/// Storage: `kSecClassGenericPassword`, account `rootkey.v1`, service
/// = bundle id (or fallback under `swift test`). Accessibility is
/// `AfterFirstUnlockThisDeviceOnly` (background-readable post unlock,
/// no iCloud, no device-to-device restore). No biometrics. Raw 16
/// bytes; keychain encrypts transparently.
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
        // Fallback covers ad-hoc tooling without a bundle id (e.g. macOS
        // unit-test process). Production always has one.
        self.service = service
            ?? Bundle.main.bundleIdentifier
            ?? "com.comapeo.core"
    }

    /// Generates and persists on first launch; subsequent calls return
    /// the stored bytes. Throws on keychain unavailable (device locked
    /// since reboot) or wrong length — never silently regenerates.
    func loadOrInitialize() throws -> RootKeyResult {
        if let existing = try load() {
            return RootKeyResult(key: existing, generated: false)
        }
        let fresh = try generate()
        try store(fresh)
        return RootKeyResult(key: fresh, generated: true)
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
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: RootKeyStore.account,
        ]
    }
}
