// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ComapeoCore",
    platforms: [.macOS(.v13), .iOS(.v15)],
    dependencies: [
        // Sentry-Cocoa is pinned to the exact version `@sentry/react-native@7.x`
        // ships via CocoaPods (see `ios/ComapeoCore.podspec` and the
        // `scripts/check-sentry-cocoa-pin.mjs` invariant). Pinning `exact:`
        // matches the pod's `'Sentry/HybridSDK', '8.58.0'` pin — the bridge
        // uses `@_spi(Private)` symbols whose surface isn't covered by
        // semver, so any drift is a manual review event.
        .package(
            url: "https://github.com/getsentry/sentry-cocoa",
            exact: "8.58.0"
        ),
    ],
    targets: [
        .target(
            name: "ComapeoCore",
            dependencies: [
                .product(name: "Sentry", package: "sentry-cocoa"),
            ],
            path: ".",
            // RootKeyStore.swift uses Keychain APIs that the macOS
            // swift-test target doesn't exercise (tests inject the rootkey
            // via NodeJSService.RootKeyProvider). Excluded explicitly so
            // SPM doesn't emit "unhandled file" noise; the production
            // CocoaPods build picks it up via `s.source_files = "*.swift"`.
            exclude: [
                "Tests",
                "ComapeoCore.podspec",
                "Package.swift",
                "ComapeoCoreModule.swift",
                "AppLifecycleDelegate.swift",
                "RootKeyStore.swift",
            ],
            sources: [
                "NodeJSIPC.swift",
                "NodeJSService.swift",
                "ControlFrame.swift",
                "Log.swift",
                "ComapeoPrefs.swift",
                "SentryConfig.swift",
                "SentryNativeBridge.swift",
                "SentryTags.swift",
            ]
        ),
        .testTarget(
            name: "ComapeoCoreTests",
            dependencies: ["ComapeoCore"],
            path: "Tests"
        ),
    ]
)
