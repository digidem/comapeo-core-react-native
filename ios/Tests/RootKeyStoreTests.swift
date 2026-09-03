import Security
import XCTest

@testable import ComapeoCore

/// Master-key cache matrix (docs/master-key-cache-plan.md §6). Runs against
/// the host keychain — generic-password items work on macOS, so these need no
/// simulator. The rootkey's own on-device semantics stay covered by the
/// integration app's `RootKeyStoreTests`.
///
/// Each test uses a unique `service` so concurrent runs don't see one
/// another's items, and `tearDown` removes both accounts even when a test
/// fails mid-way.
final class RootKeyStoreMasterKeyTests: XCTestCase {
    private var service: String = ""
    private let masterKey = Data((0..<32).map { UInt8($0) })

    override func setUp() {
        super.setUp()
        service = "comapeo.tests.masterkey.\(UUID().uuidString)"
    }

    override func tearDown() {
        for account in [RootKeyStore.account, RootKeyStore.masterKeyAccount] {
            SecItemDelete([
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: account,
            ] as CFDictionary)
        }
        super.tearDown()
    }

    private func fingerprint(_ rootKey: Data) -> Data {
        RootKeyStore.fingerprint(of: rootKey)
    }

    private func rawMasterKeyEntry() -> Data? {
        var item: CFTypeRef?
        let status = SecItemCopyMatching(
            [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: RootKeyStore.masterKeyAccount,
                kSecReturnData as String: true,
                kSecMatchLimit as String: kSecMatchLimitOne,
            ] as CFDictionary,
            &item
        )
        guard status == errSecSuccess else { return nil }
        return item as? Data
    }

    private func plantMasterKeyEntry(_ value: Data) {
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: RootKeyStore.masterKeyAccount,
        ] as CFDictionary)
        let status = SecItemAdd(
            [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: RootKeyStore.masterKeyAccount,
                kSecValueData as String: value,
                kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            ] as CFDictionary,
            nil
        )
        XCTAssertEqual(status, errSecSuccess, "precondition: planted item must save")
    }

    func testMasterKeyRoundTripsThroughTheCache() throws {
        let rootKey = try RootKeyStore(service: service).loadOrInitialize().key
        RootKeyStore(service: service).storeMasterKey(masterKey, rootKeyFingerprint: fingerprint(rootKey))

        // Fresh instance proves the entry survives in the keychain.
        let loaded = RootKeyStore(service: service).loadMasterKey(rootKey: rootKey)
        XCTAssertEqual(loaded, masterKey, "cache must return the stored bytes verbatim")
    }

    func testMissReturnsNil() throws {
        let rootKey = try RootKeyStore(service: service).loadOrInitialize().key
        XCTAssertNil(RootKeyStore(service: service).loadMasterKey(rootKey: rootKey))
    }

    func testWrongLengthEntryReturnsNilAndIsDeleted() throws {
        let rootKey = try RootKeyStore(service: service).loadOrInitialize().key
        plantMasterKeyEntry(Data(repeating: 0xAB, count: 39))

        XCTAssertNil(RootKeyStore(service: service).loadMasterKey(rootKey: rootKey))
        XCTAssertNil(rawMasterKeyEntry(), "a wrong-length entry must be deleted, not left to fail again")
    }

    func testFingerprintMismatchReturnsNilAndIsDeleted() throws {
        let rootKey = try RootKeyStore(service: service).loadOrInitialize().key
        RootKeyStore(service: service).storeMasterKey(masterKey, rootKeyFingerprint: fingerprint(rootKey))

        // Same service, different rootkey — the packed fingerprint is the only
        // thing that can catch a rootkey change the cache never saw.
        let otherRootKey = Data(repeating: 0x5A, count: RootKeyStore.rootKeyByteLength)
        XCTAssertNil(RootKeyStore(service: service).loadMasterKey(rootKey: otherRootKey))
        XCTAssertNil(rawMasterKeyEntry(), "stale entry must be deleted")
    }

    func testRootKeyGenerationClearsTheMasterKeyCache() throws {
        // Seed an entry that predates the rootkey write.
        plantMasterKeyEntry(Data(repeating: 0x01, count: 40))

        _ = try RootKeyStore(service: service).loadOrInitialize()

        XCTAssertNil(rawMasterKeyEntry(), "first-install rootkey write must clear the cache")
    }

    func testWrongLengthMasterKeyIsNotPersisted() throws {
        let rootKey = try RootKeyStore(service: service).loadOrInitialize().key

        RootKeyStore(service: service).storeMasterKey(Data(repeating: 0x7, count: 31), rootKeyFingerprint: fingerprint(rootKey))

        XCTAssertNil(rawMasterKeyEntry(), "a short master key must never be persisted")
        XCTAssertNil(RootKeyStore(service: service).loadMasterKey(rootKey: rootKey))
    }

    func testWrongLengthFingerprintIsNotPersisted() throws {
        let rootKey = try RootKeyStore(service: service).loadOrInitialize().key

        RootKeyStore(service: service).storeMasterKey(masterKey, rootKeyFingerprint: Data(count: 4))

        XCTAssertNil(rawMasterKeyEntry(), "an entry the load path could never match must not be written")
        XCTAssertNil(RootKeyStore(service: service).loadMasterKey(rootKey: rootKey))
    }

    func testStoredValueIsFingerprintPlusMasterKey() throws {
        let rootKey = try RootKeyStore(service: service).loadOrInitialize().key
        RootKeyStore(service: service).storeMasterKey(masterKey, rootKeyFingerprint: fingerprint(rootKey))

        let raw = try XCTUnwrap(rawMasterKeyEntry())
        XCTAssertEqual(raw.count, RootKeyStore.fingerprintByteLength + RootKeyStore.masterKeyByteLength)
        XCTAssertEqual(raw.suffix(RootKeyStore.masterKeyByteLength), masterKey)
    }

    func testStoreOverwritesAnExistingEntry() throws {
        let rootKey = try RootKeyStore(service: service).loadOrInitialize().key
        let store = RootKeyStore(service: service)
        store.storeMasterKey(masterKey, rootKeyFingerprint: fingerprint(rootKey))

        let replacement = Data(repeating: 0x33, count: 32)
        store.storeMasterKey(replacement, rootKeyFingerprint: fingerprint(rootKey))

        XCTAssertEqual(store.loadMasterKey(rootKey: rootKey), replacement)
    }
}
