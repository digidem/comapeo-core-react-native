// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ComapeoCore",
    platforms: [.macOS(.v13), .iOS(.v15)],
    targets: [
        .target(
            name: "ComapeoCore",
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
            ]
        ),
        .testTarget(
            name: "ComapeoCoreTests",
            dependencies: ["ComapeoCore"],
            path: "Tests"
        ),
    ]
)
