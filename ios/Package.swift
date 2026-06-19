// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ComapeoCore",
    platforms: [.macOS(.v13), .iOS(.v16)],
    dependencies: [
        // Pinned to match the `Sentry` dep in ComapeoCore.podspec (and
        // the `scripts/check-sentry-cocoa-pin.mjs` invariant). The bridge
        // uses `@_spi(Private)` symbols — drift is a manual-review event.
        .package(
            url: "https://github.com/getsentry/sentry-cocoa",
            exact: "9.18.0"
        ),
    ],
    targets: [
        .target(
            name: "ComapeoCore",
            dependencies: [
                .product(name: "Sentry", package: "sentry-cocoa"),
            ],
            path: ".",
            // Excluded files use Keychain / Expo APIs not available in the
            // macOS swift-test target. Tests inject rootkey via
            // `NodeJSService.RootKeyProvider`. CocoaPods picks them up via
            // `s.source_files = "*.swift"`.
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
                // MetricKit subscriber is #if os(iOS); only the pure
                // AppExitDecoder compiles (and is tested) on macOS.
                "AppExitMetricsCollector.swift",
            ]
        ),
        .testTarget(
            name: "ComapeoCoreTests",
            dependencies: ["ComapeoCore"],
            path: "Tests"
        ),
    ]
)
