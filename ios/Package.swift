// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ComapeoCore",
    platforms: [.macOS(.v13), .iOS(.v15)],
    targets: [
        .target(
            name: "ComapeoCore",
            path: ".",
            exclude: [
                "Tests",
                "ComapeoCore.podspec",
                "Package.swift",
                "ComapeoCoreModule.swift",
                "AppLifecycleDelegate.swift",
            ],
            sources: ["NodeJSIPC.swift", "NodeJSService.swift", "Log.swift"]
        ),
        .testTarget(
            name: "ComapeoCoreTests",
            dependencies: ["ComapeoCore"],
            path: "Tests"
        ),
    ]
)
