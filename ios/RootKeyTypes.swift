import Foundation

/// `generated=true` → first-install path. NodeJSService stamps this on
/// the `boot.rootkey-load` span. Separate file from `RootKeyStore`
/// because that's excluded from the SPM target (macOS has no Keychain).
struct RootKeyResult {
    let key: Data
    let generated: Bool
}
