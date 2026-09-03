import CryptoKit
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
///
/// Also holds the master-key cache (``loadMasterKey(rootKey:)`` /
/// ``storeMasterKey(_:rootKey:)``) — same service and accessibility, but
/// pure-cache semantics: derivable, disposable, never fatal
/// (docs/master-key-cache-plan.md §6).
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

    /// Cache slot for the master key derived from the rootkey. Value is
    /// `fp(8) ‖ masterKey(32)`, where `fp` binds the entry to the rootkey it
    /// came from; the keychain value is opaque bytes, so the fingerprint is
    /// packed rather than enveloped.
    static let masterKeyAccount = "masterkey.v1"
    static let masterKeyByteLength = 32
    static let fingerprintByteLength = 8

    private static let metricMasterKeyLoad = "masterkey.load"
    private static let metricMasterKeyStore = "masterkey.store"

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
        // Delete-then-write, never the reverse: the keychain has no
        // cross-item atomicity, and a crash between the two must leave a
        // missing cache (self-heals) rather than one bound to a rootkey that
        // no longer exists. Lives here so no rootkey-writing path can skip it.
        deleteMasterKey()

        var attributes = baseQuery()
        attributes[kSecValueData as String] = key
        attributes[kSecAttrAccessible as String] =
            kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

        let status = SecItemAdd(attributes as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw RootKeyError.unexpectedKeychainError(status)
        }
    }

    // MARK: - Master-key cache

    /// Cache read for the master key derived from `rootKey`. Returns nil on a
    /// miss, a wrong-length value, a fingerprint that does not bind to
    /// `rootKey`, or any other keychain error — deleting the stale entry on
    /// every failure path.
    ///
    /// Never throws, deliberately unlike `loadOrInitialize()`: the master key
    /// is re-derivable, so a bad entry costs one slow boot, not the identity.
    func loadMasterKey(rootKey: Data) -> Data? {
        var query = baseQuery(account: RootKeyStore.masterKeyAccount)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound {
            countMasterKeyMetric(RootKeyStore.metricMasterKeyLoad, outcome: "miss")
            return nil
        }
        guard status == errSecSuccess, let value = item as? Data else {
            return dropMasterKey(outcome: "keychain-error")
        }
        let expected = RootKeyStore.fingerprintByteLength + RootKeyStore.masterKeyByteLength
        guard value.count == expected else {
            return dropMasterKey(outcome: "invalid")
        }
        guard
            value.subdata(in: 0..<RootKeyStore.fingerprintByteLength)
                == RootKeyStore.fingerprint(of: rootKey)
        else {
            return dropMasterKey(outcome: "fingerprint-mismatch")
        }
        log("RootKeyStore: masterkey cache hit")
        countMasterKeyMetric(RootKeyStore.metricMasterKeyLoad, outcome: "hit")
        return value.subdata(in: RootKeyStore.fingerprintByteLength..<expected)
    }

    /// Cache write: stamps `rootKeyFingerprint`, writes, then reads back and
    /// byte-compares. Any failure is logged, metered, and the entry dropped —
    /// never thrown, the next boot simply re-derives.
    ///
    /// Takes the fingerprint rather than the rootkey because the caller has
    /// already zeroed the rootkey by the time the backend's key arrives.
    func storeMasterKey(_ masterKey: Data, rootKeyFingerprint: Data) {
        guard masterKey.count == RootKeyStore.masterKeyByteLength else {
            failMasterKeyStore("refusing to persist masterkey of wrong length")
            return
        }
        guard rootKeyFingerprint.count == RootKeyStore.fingerprintByteLength else {
            failMasterKeyStore("refusing to persist masterkey with a wrong-length fingerprint")
            return
        }
        let value = rootKeyFingerprint + masterKey

        deleteMasterKey()
        var attributes = baseQuery(account: RootKeyStore.masterKeyAccount)
        attributes[kSecValueData as String] = value
        attributes[kSecAttrAccessible as String] =
            kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(attributes as CFDictionary, nil)
        guard status == errSecSuccess else {
            failMasterKeyStore("keychain write failed (OSStatus \(status))")
            return
        }
        guard readMasterKeyValue() == value else {
            deleteMasterKey()
            failMasterKeyStore("masterkey verification mismatch after write")
            return
        }
        countMasterKeyMetric(RootKeyStore.metricMasterKeyStore, outcome: "ok")
    }

    private func readMasterKeyValue() -> Data? {
        var query = baseQuery(account: RootKeyStore.masterKeyAccount)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess else {
            return nil
        }
        return item as? Data
    }

    private func deleteMasterKey() {
        SecItemDelete(baseQuery(account: RootKeyStore.masterKeyAccount) as CFDictionary)
    }

    private func dropMasterKey(outcome: String) -> Data? {
        deleteMasterKey()
        log("RootKeyStore: masterkey cache entry deleted (\(outcome))", level: .warning)
        countMasterKeyMetric(RootKeyStore.metricMasterKeyLoad, outcome: outcome)
        return nil
    }

    private func failMasterKeyStore(_ reason: String) {
        log("RootKeyStore: masterkey cache write failed (\(reason))", level: .warning)
        countMasterKeyMetric(RootKeyStore.metricMasterKeyStore, outcome: "failed")
    }

    private func countMasterKeyMetric(_ key: String, outcome: String) {
        SentryNativeBridge.countMetric(key, value: 1, attributes: ["outcome": outcome])
    }

    /// First `fingerprintByteLength` bytes of SHA-256(rootKey), binding a
    /// cache entry to the rootkey it was derived from. Not secret: a truncated
    /// hash of a key that never leaves the device.
    static func fingerprint(of rootKey: Data) -> Data {
        Data(SHA256.hash(data: rootKey).prefix(RootKeyStore.fingerprintByteLength))
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

    private func baseQuery(account: String = RootKeyStore.account) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}
