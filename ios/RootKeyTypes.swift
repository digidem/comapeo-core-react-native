import Foundation

/// Result of ``RootKeyStore/loadOrInitialize()``. `generated = true` means
/// this call performed first-install key generation; `false` means the
/// rootkey was loaded from an existing keychain item. NodeJSService surfaces
/// this as span data on `boot.rootkey-load` so first-install boots (where
/// `SecRandomCopyBytes` + keychain write add latency) are distinguishable
/// in Sentry from steady-state boots.
///
/// Lives in its own file (rather than alongside `RootKeyStore`) because
/// `RootKeyStore.swift` is excluded from the SPM target — its Keychain
/// APIs aren't available on macOS — and `NodeJSService.swift`'s
/// `RootKeyProvider` typealias needs this type visible from inside that
/// target.
struct RootKeyResult {
    let key: Data
    let generated: Bool
}
