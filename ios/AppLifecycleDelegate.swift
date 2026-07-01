import ExpoModulesCore
import UIKit

/// Expo lifecycle delegate that drives the Node.js service.
///
/// `NodeMobileStartNode` is once-per-process: the service cannot be
/// stopped on background and restarted on foreground. Node keeps
/// running across transitions; iOS may suspend or kill, in which case
/// the next foreground is a fresh process. Only graceful-shutdown hook
/// is `applicationWillTerminate`.
///
/// The `NodeJSService` is held by the static below. Expo autolinking
/// instantiates its own `AppLifecycleDelegate`; every instance routes
/// through that single static.
public class AppLifecycleDelegate: ExpoAppDelegateSubscriber {
    /// Lazy because static-init order doesn't guarantee
    /// `Bundle.main.bundleIdentifier` is available before first
    /// reference; defer the read to handshake time.
    private static let rootKeyStore = RootKeyStore()

    /// Sentry config for this launch, gated on `diagnosticsEnabled`.
    /// When nil: NodeJSService skips `--sentry*` argv (loader
    /// short-circuits on absent DSN); native bridge calls no-op against
    /// an uninitialised sentry-cocoa. Snapshot-at-launch — toggle takes
    /// effect on next cold start.
    private static func resolveEffectiveSentryConfig() -> SentryConfig? {
        guard ComapeoPrefs.open().readDiagnosticsEnabled() else { return nil }
        return SentryConfig.loadFromMainBundle()
    }

    static let nodeService = NodeJSService(
        socketDir: AppLifecycleDelegate.resolveSocketDir(),
        privateStorageDir: AppLifecycleDelegate.resolvePrivateStorageDir(),
        nodeEntryPoint: { arguments in
            // Embedded `<name>__<version>.framework/` lives under
            // `<App>.app/Frameworks/`. The rolled-up backend reads
            // `process.env.NATIVE_LIB_DIR` and `process.dlopen`s
            // native addons from there. Setenv before
            // `NodeMobileStartNode` so it's visible at V8's first tick.
            let frameworksDir = (Bundle.main.bundlePath as NSString)
                .appendingPathComponent("Frameworks")
            setenv("NATIVE_LIB_DIR", frameworksDir, 1)

            let cStrings = arguments.map { strdup($0)! }
            defer { cStrings.forEach { free($0) } }

            var argv: [UnsafePointer<CChar>?] = cStrings.map { UnsafePointer<CChar>($0) }
            return argv.withUnsafeMutableBufferPointer { buffer -> Int32 in
                NodeMobileStartNode(Int32(arguments.count), buffer.baseAddress!)
            }
        },
        resolveJSEntryPoint: {
            // The bundled `nodejs-project/` is read directly — no extract.
            // The backend writes to `privateStorageDir`, not back into the
            // bundle. (Android can't do this; APKs don't expose a fs path.)
            let bundleEntry = (Bundle.main.bundlePath as NSString)
                .appendingPathComponent("nodejs-project/loader.mjs")
            return FileManager.default.fileExists(atPath: bundleEntry)
                ? bundleEntry
                : nil
        },
        rootKeyProvider: {
            try AppLifecycleDelegate.rootKeyStore.loadOrInitialize()
        },
        sentryConfig: AppLifecycleDelegate.resolveEffectiveSentryConfig(),
        applicationUsageData: ComapeoPrefs.open().readApplicationUsageData(),
        debug: ComapeoPrefs.open().readDebugEnabled(),
        deviceTags: DeviceTags.compute()
    )

    /// Directory for the Unix-domain socket files. The 104-byte
    /// `sockaddr_un.sun_path` limit rules out every standard sandbox
    /// location except tmp.
    ///
    /// Simulator: the sandbox tmp (~130-byte container path) is too
    /// long, so we use the host Mac's `/tmp` namespaced by host PID —
    /// two concurrent sims would collide on a fixed path. Stale
    /// `/tmp/comapeo-*` from crashes are purged by
    /// `com.apple.periodic-daily.plist` after three days; we don't gc
    /// ourselves (risk of deleting a peer sim's live socket).
    ///
    /// Device: per-app sandbox tmp (~89 bytes), no namespacing — each
    /// app has its own sandbox.
    private static func resolveSocketDir() -> String {
        #if targetEnvironment(simulator)
        return "/tmp/comapeo-\(getpid())"
        #else
        return (NSTemporaryDirectory() as NSString).standardizingPath
        #endif
    }

    /// App-private writable directory passed as `privateStorageDir`.
    /// Falls back to NSTemporaryDirectory only if Application Support
    /// is unavailable — degraded start beats crashing on launch.
    private static func resolvePrivateStorageDir() -> String {
        let fm = FileManager.default
        let base = (try? fm.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )) ?? URL(fileURLWithPath: NSTemporaryDirectory())
        return base.appendingPathComponent("comapeo", isDirectory: true).path
    }

    #if DEBUG
    /// Test-only. Tests are reliably on the main thread so the
    /// inherited `@MainActor` init won't trap. Gated to DEBUG so
    /// release builds can't reach it from off-main paths.
    static let shared = AppLifecycleDelegate()
    #endif

    public func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // Init sentry-cocoa before `applicationDidBecomeActive` fires
        // so `nodeService.start()` finds a live hub. JS-side `Sentry.init`
        // runs later with `autoInitializeNativeSdk: false`.
        if let cfg = Self.resolveEffectiveSentryConfig() {
            // Run the auto-off check before init so any queue() from
            // readDebugEnabled() precedes the consume() drain below. Otherwise
            // the only readDebugEnabled() calls this launch run after
            // didFinishLaunching (lazy nodeService / Expo constants), and the
            // crumb is lost on the launch that performed the auto-off.
            _ = ComapeoPrefs.open().readDebugEnabled()
            SentryNativeBridge.initFromConfig(cfg)
            // Drain a `debug` 24h auto-off queued by the prefs
            // reader, which runs before the SDK is up.
            if DebugAutoOff.consume() {
                SentryNativeBridge.addBreadcrumb(
                    category: "comapeo.debug.auto_disabled",
                    message: "debug auto-disabled after 24h"
                )
            }
            // MXAppExitMetric needs iOS 14+; the podspec floor (15.1)
            // guarantees it, so no availability guard.
            #if canImport(MetricKit)
            AppExitMetricsCollector.subscribeOnce()
            #endif
        }
        return true
    }

    public func applicationDidBecomeActive(_ application: UIApplication) {
        log("applicationDidBecomeActive")
        Self.nodeService.start()
    }

    public func applicationWillResignActive(_ application: UIApplication) {
        log("applicationWillResignActive")
    }

    public func applicationDidEnterBackground(_ application: UIApplication) {
        log("applicationDidEnterBackground — Node.js continues running")
        // Don't stop Node on background: NodeMobileStartNode is
        // once-per-process. iOS may suspend or kill; next launch is fresh.
    }

    public func applicationWillTerminate(_ application: UIApplication) {
        #if canImport(MetricKit)
        AppExitMetricsCollector.unsubscribe()
        #endif
        log("applicationWillTerminate — stopping Node.js")
        // iOS grants ~5s; 5 leaves no margin but Node typically exits in
        // ~1s. On timeout, NodeJSService lands in .error (process is
        // about to die anyway).
        Self.nodeService.stop(timeout: 5)
    }
}
