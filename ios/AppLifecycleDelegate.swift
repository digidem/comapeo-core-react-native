import ExpoModulesCore
import UIKit

/// Expo lifecycle delegate that manages the Node.js service in response to
/// iOS application lifecycle events.
///
/// `NodeMobileStartNode` can only be called once per process, so the service
/// cannot be stopped on background and then restarted on foreground. Instead,
/// Node.js keeps running across background/foreground transitions; iOS may
/// suspend or kill the process during long background windows, at which point
/// the next foreground is a fresh process with a fresh single-use slot. The
/// only graceful-shutdown hook is `applicationWillTerminate`.
///
/// The actual `NodeJSService` is held by the `static let nodeService` below.
/// Expo's autolinking instantiates its own `AppLifecycleDelegate` for lifecycle
/// callbacks, but every instance routes through that single static — so
/// `NodeMobileStartNode`'s once-per-process constraint is preserved no matter
/// how many delegate instances exist.
public class AppLifecycleDelegate: ExpoAppDelegateSubscriber {
    /// Process-wide `NodeJSService`. Use this from any thread.
    ///
    /// Going through a delegate instance (e.g. via the DEBUG-only `shared`
    /// below) would force lazy init of `AppLifecycleDelegate`; its superclass
    /// `BaseExpoAppDelegateSubscriber` derives from `UIResponder`, which is
    /// `@MainActor`-isolated under Xcode 26 / Swift 6. Initialising off-main
    /// trips Swift's runtime executor check (SIGTRAP via
    /// `_swift_task_checkIsolatedSwift`) — that's exactly what `OnCreate` in
    /// `ComapeoCoreModule` does, since Expo runs it on the React Native JS
    /// thread.
    ///
    /// Use `/tmp` for socket files so the path stays within the 104-byte
    /// `sockaddr_un.sun_path` limit. The app's Documents/tmp directory can
    /// exceed it on iOS Simulator runners; on a real iOS device, `/tmp` is
    /// sandboxed to the app's container.
    ///
    /// `privateStorageDir` is the analogue of Android's `getFilesDir()`: an
    /// app-private writable directory that survives across process restarts
    /// (and, on iOS, is excluded from iCloud backup by default for
    /// Application Support). The embedded ComapeoManager opens its SQLite
    /// database and writes blobs/projects under here.
    static let nodeService = NodeJSService(
        filesDir: "/tmp/comapeo",
        privateStorageDir: AppLifecycleDelegate.resolvePrivateStorageDir(),
        nodeEntryPoint: { arguments in
            // Frameworks directory inside the .app bundle. Xcode's
            // Embed & Sign phase places one `<name>.framework/`
            // subdirectory here at app build time, populated from each
            // `Frameworks/<name>.xcframework` emitted by
            // `scripts/build-backend.ts`. The rolled-up backend reads
            // this via `process.env.NATIVE_LIB_DIR` (see
            // `backend/rollup-plugins/rollup-plugin-ios-addon-loader.js`)
            // and `process.dlopen`s
            // `<NATIVE_LIB_DIR>/<name>.framework/<name>` for each
            // native addon. Setenv'd before `NodeMobileStartNode` so
            // the value is visible from V8's first tick — bundle-level
            // addon-loader rewrites run inside that V8 evaluation.
            let frameworksDir = (Bundle.main.bundlePath as NSString)
                .appendingPathComponent("Frameworks")
            setenv("NATIVE_LIB_DIR", frameworksDir, 1)

            let cStrings = arguments.map { strdup($0)! }
            defer { cStrings.forEach { free($0) } }

            var argv: [UnsafePointer<CChar>?] = cStrings.map { UnsafePointer($0) }
            return argv.withUnsafeMutableBufferPointer { buffer -> Int32 in
                return NodeMobileStartNode(Int32(arguments.count), buffer.baseAddress!)
            }
        },
        resolveJSEntryPoint: {
            // The unified backend bundle is ESM (`index.mjs`). Both Android
            // and iOS resolve the same entry filename now — Android's
            // NodeJSService.kt has used `index.mjs` since the rollup build
            // landed; iOS catches up here.
            //
            // The rolled-up backend ships read-only inside the .app
            // bundle, but nodejs-mobile wants a filesystem path it can
            // mutate (drizzle migrations are `fs.readFile`d at runtime
            // from `node_modules/@comapeo/core/drizzle/*.sql`, and
            // anything else that `fs.writeFile`s siblings to the entry
            // would otherwise hit EROFS). Copy the tree into Application
            // Support and return the writable `index.mjs` path.
            //
            // Phase 2: native `.node` files no longer live alongside
            // the JS — they ship as `<App>.app/Frameworks/<name>.framework/`
            // and load via `process.dlopen` against `NATIVE_LIB_DIR`
            // (set in the `nodeEntryPoint` closure above). The Phase 1
            // arch-slice merge is gone.
            AppLifecycleDelegate.prepareNodeBundle()
        }
    )

    /// Copies the bundled `nodejs-project/` tree into Application Support
    /// and returns the path to the `index.mjs` inside. nodejs-mobile needs
    /// a filesystem entry path; the .app bundle is read-only, so we stage
    /// to a writable location every cold start. Phase 2.5 will add a
    /// `CFBundleVersion`-based stamp to skip the copy when the bundle
    /// hasn't changed (mirrors Android's `shouldCopyAssets` pattern in
    /// NodeJSService.kt).
    private static func prepareNodeBundle() -> String? {
        let fm = FileManager.default
        let bundleProjectDir = (Bundle.main.bundlePath as NSString)
            .appendingPathComponent("nodejs-project")

        guard fm.fileExists(atPath: bundleProjectDir) else {
            log("Cannot prepare node bundle: missing nodejs-project")
            return nil
        }

        let appSupport = (try? fm.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )) ?? URL(fileURLWithPath: NSTemporaryDirectory())
        let runtimeRoot = appSupport
            .appendingPathComponent("comapeo-runtime", isDirectory: true).path
        let runtimeProject = (runtimeRoot as NSString)
            .appendingPathComponent("nodejs-project")

        do {
            if fm.fileExists(atPath: runtimeProject) {
                try fm.removeItem(atPath: runtimeProject)
            }
            try fm.createDirectory(atPath: runtimeRoot, withIntermediateDirectories: true)
            try fm.copyItem(atPath: bundleProjectDir, toPath: runtimeProject)
        } catch {
            log("Failed to prepare node bundle: \(error)")
            return nil
        }

        return (runtimeProject as NSString).appendingPathComponent("index.mjs")
    }

    /// Resolves the app-private writable directory passed to the backend as
    /// `privateStorageDir`. Falls back to NSTemporaryDirectory only if
    /// Application Support is somehow unavailable, which would indicate a
    /// broken sandbox — we'd rather start in a degraded state and surface
    /// the failure later than crash on launch.
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
    /// Test-only entry point. Test code occasionally needs an
    /// `AppLifecycleDelegate` instance — e.g. to drive
    /// `applicationDidEnterBackground(_:)` directly — and tests are reliably
    /// invoked on the main thread, so the `@MainActor` isolation on the
    /// inherited init doesn't trap. Production code never sees this symbol:
    /// it's gated to DEBUG builds so the surface area can't accidentally
    /// be reached from off-main paths in a release.
    static let shared = AppLifecycleDelegate()
    #endif

    public func applicationDidBecomeActive(_ application: UIApplication) {
        log("applicationDidBecomeActive")
        // Start is guarded by `state == .stopped`, so subsequent foreground
        // transitions in the same process are no-ops.
        Self.nodeService.start()
    }

    public func applicationWillResignActive(_ application: UIApplication) {
        log("applicationWillResignActive")
    }

    public func applicationDidEnterBackground(_ application: UIApplication) {
        log("applicationDidEnterBackground — Node.js continues running")
        // Deliberately do NOT stop Node on background: NodeMobileStartNode
        // is once-per-process, so stopping here would permanently break the
        // app on the next foreground. iOS may suspend or terminate the
        // process during long background windows; when that happens the
        // next launch is a fresh process.
    }

    public func applicationWillTerminate(_ application: UIApplication) {
        log("applicationWillTerminate — stopping Node.js")
        // Final graceful-shutdown hook. Synchronous with a short timeout since
        // termination is imminent. iOS grants ~5 s total for this callback; using
        // the full 5 s leaves no margin. In practice Node exits within ~1 s when
        // it receives the shutdown message, so the budget is rarely exhausted.
        // If it times out, NodeJSService transitions to .error (the node thread is
        // still alive, but the process is about to die, so that's acceptable).
        Self.nodeService.stop(timeout: 5)
    }
}
