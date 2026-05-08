import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// Builds the static-only `sentryContext` blob attached to the init
/// control frame. Backend's loader merges these onto every event via
/// `Sentry.addEventProcessor`, overwriting `nodeContextIntegration`'s
/// Darwin-libnode view with the actual user-facing iOS values.
///
/// Only fields that don't change during a session — battery, network,
/// foreground state etc. live with Phase 5's update frame.
enum SentryNativeContext {
    /// Returns the JSON-encoded blob ready to splice into the init
    /// frame. `nil` on failure so a builder bug never blocks boot.
    static func buildJSON() -> String? {
        guard let data = try? JSONSerialization.data(
            withJSONObject: build(),
            options: []
        ) else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    static func build() -> [String: Any] {
        let info = Bundle.main.infoDictionary ?? [:]
        let model = deviceModelIdentifier()
        let isSimulator: Bool = {
            #if targetEnvironment(simulator)
            return true
            #else
            return false
            #endif
        }()
        let family = familyForModel(model)
        let processorCount = ProcessInfo.processInfo.processorCount

        var device: [String: Any] = [
            "manufacturer": "Apple",
            "brand": "Apple",
            "model": model,
            "family": family,
            "arch": currentArch(),
            "simulator": isSimulator,
            "processor_count": processorCount,
            "memory_size": ProcessInfo.processInfo.physicalMemory,
        ]

        #if canImport(UIKit)
        let screen = UIScreen.main
        let bounds = screen.nativeBounds
        device["screen_resolution"] = "\(Int(bounds.width))x\(Int(bounds.height))"
        device["screen_density"] = screen.scale
        device["screen_dpi"] = Int(screen.scale * 160)
        #endif

        if let storage = totalStorageBytes() {
            device["storage_size"] = storage
        }

        var os: [String: Any] = [:]
        #if canImport(UIKit)
        os["name"] = UIDevice.current.systemName
        os["version"] = UIDevice.current.systemVersion
        #else
        os["name"] = "iOS"
        os["version"] = "unknown"
        #endif
        if let kernel = sysctlString("kern.osrelease") {
            os["kernel_version"] = kernel
        }
        if let build = sysctlString("kern.osversion") {
            os["build"] = build
        }

        var app: [String: Any] = [:]
        if let bundleId = Bundle.main.bundleIdentifier {
            app["app_identifier"] = bundleId
        }
        if let v = info["CFBundleShortVersionString"] as? String {
            app["app_version"] = v
        }
        if let b = info["CFBundleVersion"] as? String {
            app["app_build"] = b
        }
        if let n = info["CFBundleName"] as? String {
            app["app_name"] = n
        }

        let culture: [String: Any] = [
            "locale": Locale.current.identifier,
            "timezone": TimeZone.current.identifier,
        ]

        let tags: [String: Any] = [
            "os.name": (os["name"] as? String) ?? "iOS",
            "device.family": family,
            "device.simulator": String(isSimulator),
        ]

        return [
            "device": device,
            "os": os,
            "app": app,
            "culture": culture,
            "tags": tags,
        ]
    }

    /// e.g. "iPhone14,3", "iPad13,8". Matches what sentry-cocoa's
    /// `device.model` reports.
    private static func deviceModelIdentifier() -> String {
        var sysinfo = utsname()
        uname(&sysinfo)
        return withUnsafePointer(to: &sysinfo.machine) {
            $0.withMemoryRebound(to: CChar.self, capacity: 1) {
                String(cString: $0)
            }
        }
    }

    /// "iPhone" / "iPad" / "iPod" / "Mac" / "unknown".
    private static func familyForModel(_ model: String) -> String {
        if model.hasPrefix("iPhone") { return "iPhone" }
        if model.hasPrefix("iPad") { return "iPad" }
        if model.hasPrefix("iPod") { return "iPod" }
        if model.hasPrefix("Mac") || model.hasPrefix("arm") { return "Mac" }
        return "unknown"
    }

    private static func currentArch() -> String {
        #if arch(arm64)
        return "arm64"
        #elseif arch(x86_64)
        return "x86_64"
        #elseif arch(i386)
        return "i386"
        #else
        return "unknown"
        #endif
    }

    private static func sysctlString(_ name: String) -> String? {
        var size: size_t = 0
        sysctlbyname(name, nil, &size, nil, 0)
        guard size > 0 else { return nil }
        var buf = [CChar](repeating: 0, count: size)
        if sysctlbyname(name, &buf, &size, nil, 0) != 0 { return nil }
        return String(cString: buf)
    }

    private static func totalStorageBytes() -> Int64? {
        let url = URL(fileURLWithPath: NSHomeDirectory())
        let values = try? url.resourceValues(forKeys: [
            .volumeTotalCapacityKey,
        ])
        if let total = values?.volumeTotalCapacity { return Int64(total) }
        return nil
    }
}
