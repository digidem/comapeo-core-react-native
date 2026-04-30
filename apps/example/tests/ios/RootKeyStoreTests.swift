import XCTest
import Security
@testable internal import ComapeoCore

/// Round-trip + corruption tests for `RootKeyStore`. Runs against the
/// simulator's iOS Keychain.
///
/// Each test uses a unique `service` string so concurrent runs (and
/// re-runs after a crash) don't see one another's leftover items.
/// `tearDown` deletes the test's items even if assertions failed mid-test;
/// the simulator persists keychain state across boots, so leaks would
/// accumulate over time without explicit cleanup.
final class RootKeyStoreTests: XCTestCase {
    private var service: String = ""

    override func setUp() {
        super.setUp()
        service = "comapeo.tests.rootkey.\(UUID().uuidString)"
    }

    override func tearDown() {
        deleteKeychainItem(service: service)
        super.tearDown()
    }

    /// Removes the test's keychain entry. Errors-by-not-found are
    /// expected (e.g. when a test threw before persisting); other status
    /// codes are not, but tearDown swallowing them keeps the test
    /// failure message focused on the actual assertion that broke.
    private func deleteKeychainItem(service: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: RootKeyStore.account,
        ]
        SecItemDelete(query as CFDictionary)
    }

    func testFirstCallGeneratesAndSecondCallReturnsSameBytes() throws {
        let store = RootKeyStore(service: service)
        let first = try store.loadOrInitialize()
        XCTAssertEqual(
            first.count,
            RootKeyStore.rootKeyByteLength,
            "rootkey must be 16 bytes"
        )

        // Fresh instance proves persistence — anything that returns
        // different bytes here is identity loss.
        let second = try RootKeyStore(service: service).loadOrInitialize()
        XCTAssertEqual(
            first,
            second,
            "second call must return identical bytes (else identity rotation)"
        )
    }

    func testWrongLengthStoredValueThrows() {
        // Manually plant a 12-byte entry to simulate a future format
        // change or external tampering. The contract is "throw, do not
        // silently regenerate" — anything that swallows this masks
        // identity loss.
        let bogus = Data(repeating: 0xAB, count: 12)
        let attrs: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: RootKeyStore.account,
            kSecValueData as String: bogus,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemAdd(attrs as CFDictionary, nil)
        XCTAssertEqual(status, errSecSuccess, "precondition: planted item must save")

        do {
            _ = try RootKeyStore(service: service).loadOrInitialize()
            XCTFail("loadOrInitialize must throw on wrong-length stored value")
        } catch let error as RootKeyStore.RootKeyError {
            switch error {
            case .wrongLength(let n):
                XCTAssertEqual(n, 12)
            default:
                XCTFail("unexpected RootKeyError: \(error)")
            }
        } catch {
            XCTFail("unexpected error type: \(error)")
        }
    }
}
