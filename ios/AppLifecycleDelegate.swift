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
///
/// On first instantiation by Expo's autolinking, this class also wires
/// `MediaURLProtocol` into the global URL-loading system so `comapeo://media/...`
/// URLs (the platform-native form of `BlobApi.getUrl()` / `IconApi.getIconUrl()`
/// results, see `src/mediaUrl.ts`) stream straight from the backend's
/// UDS-bound HTTP server into React Native image components.
public class AppLifecycleDelegate: ExpoAppDelegateSubscriber {
    /// Idempotent installer for the media URL fetch path — `static let`
    /// guarantees at-most-one registration regardless of how many
    /// `AppLifecycleDelegate` instances Expo creates. Side-effect happens
    /// the first time anything reads this property; the value itself is
    /// only there to make the body run.
    ///
    /// Two consumers wire up here:
    ///   - `MediaFetcher.socketPathProvider` — read by the Obj-C
    ///     `ComapeoMediaImageLoader` (`RCTImageURLLoader`) which RN's
    ///     `<Image>` looks up by scheme, AND by the streaming
    ///     `MediaURLProtocol` below.
    ///   - `URLProtocol.registerClass(MediaURLProtocol.self)` — picks up
    ///     `URLSession.shared` callers (share sheet, third-party libs)
    ///     for which the RCTImageURLLoader path is irrelevant.
    private static let _mediaUrlProtocolInstalled: Bool = {
        MediaFetcher.socketPathProvider = {
            AppLifecycleDelegate.nodeService.mediaSocketPath
        }
        URLProtocol.registerClass(MediaURLProtocol.self)
        return true
    }()
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
    /// `socketDir` is constrained by Darwin's 104-byte
    /// `sockaddr_un.sun_path` limit, which rules out every standard
    /// iOS sandbox location except the per-app `tmp` directory:
    /// `Documents/`, `Library/Application Support/`, and
    /// `Library/Caches/` all push the path over 104 bytes once a
    /// 12-byte socket basename is appended. `tmp/` is the only fit on
    /// device.
    ///
    /// On iOS Simulator the equivalent sandbox `tmp` is also too long
    /// (~130-byte CoreSimulator container path); but the simulator's
    /// system `/tmp` IS the host Mac's `/tmp` and is writable from any
    /// process, so we land sockets there. On real device the system
    /// `/tmp` is NOT in the app sandbox — bind() returns `EACCES` —
    /// so we use `NSTemporaryDirectory()` (the per-app sandbox tmp,
    /// ~89 bytes) which fits one 12-byte basename with no nesting.
    /// See `resolveSocketDir()` for the per-environment dispatch.
    ///
    /// `privateStorageDir` is the analogue of Android's `getFilesDir()`: an
    /// app-private writable directory that survives across process restarts
    /// (and, on iOS, is excluded from iCloud backup by default for
    /// Application Support). The embedded ComapeoManager opens its SQLite
    /// database and writes blobs/projects under here.
    static let nodeService = NodeJSService(
        socketDir: AppLifecycleDelegate.resolveSocketDir(),
        privateStorageDir: AppLifecycleDelegate.resolvePrivateStorageDir(),
        nodeEntryPoint: { arguments in
            // Frameworks directory inside the .app bundle. Xcode's
            // Embed & Sign phase places one `<name>__<version>.framework/`
            // subdirectory here at app build time, populated from each
            // `Frameworks/<name>__<version>.xcframework` emitted by
            // `scripts/build-backend.ts`. The rolled-up backend reads
            // this via `process.env.NATIVE_LIB_DIR` (see
            // `backend/rollup-plugins/rollup-plugin-addon-loader.js`)
            // and `process.dlopen`s
            // `<NATIVE_LIB_DIR>/<name>__<version>.framework/<name>__<version>`
            // for each native addon. Setenv'd before `NodeMobileStartNode`
            // so the value is visible from V8's first tick — bundle-level
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
            // Hand nodejs-mobile the read-only path inside the .app
            // bundle directly. Nothing in the rolled-up backend writes
            // back into `nodejs-project/` at runtime: native `.node`
            // files live in `<App>.app/Frameworks/<name>__<version>.framework/`
            // (loaded via `process.dlopen` against `NATIVE_LIB_DIR`,
            // set in the `nodeEntryPoint` closure above), drizzle
            // migrations are `fs.readFile`d, and SQLite/blobs/indexes
            // go to `privateStorageDir`.
            //
            // Android extracts on first launch instead because the APK
            // doesn't expose a filesystem-readable path to its assets
            // the way `<App>.app/<name>/` does on iOS.
            let bundleEntry = (Bundle.main.bundlePath as NSString)
                .appendingPathComponent("nodejs-project/index.mjs")
            return FileManager.default.fileExists(atPath: bundleEntry)
                ? bundleEntry
                : nil
        }
    )

    /// Resolves the directory that holds the Unix-domain socket files
    /// the backend listens on. See the `nodeService` doc above for why
    /// the simulator and device branches differ.
    ///
    /// **Simulator** uses the host Mac's `/tmp`, namespaced by host
    /// PID. The host `/tmp` is shared with every process on the box,
    /// so a fixed `/tmp/comapeo/` would collide between two
    /// concurrently-booted simulators running the same app. PID is
    /// unique per launched app instance at the host kernel level,
    /// so two sim devices each get a distinct
    /// `/tmp/comapeo-<pid>/`. PIDs can be reused after the app exits;
    /// `NodeJSService.deleteSocketFiles()` cleans up at start and at
    /// stop, and macOS's `com.apple.periodic-daily.plist` purges
    /// `/tmp` entries older than three days, which collects
    /// stragglers from any hard crash. We don't try to gc stale
    /// `/tmp/comapeo-*` directories ourselves — the cost of getting
    /// that wrong (deleting a peer simulator's live socket) outweighs
    /// the cost of carrying a handful of empty dirs for up to three
    /// days.
    ///
    /// **Device** uses the per-app sandbox tmp directly. Each app has
    /// its own sandbox so cross-instance collisions can't happen; we
    /// drop the namespace dir entirely because adding nesting would
    /// push the path over 104 bytes.
    private static func resolveSocketDir() -> String {
        #if targetEnvironment(simulator)
        return "/tmp/comapeo-\(getpid())"
        #else
        // Drop trailing slash for consistency with the simulator branch
        // and with `NSString.appendingPathComponent` callsites that
        // assume no trailing slash on the parent.
        return (NSTemporaryDirectory() as NSString).standardizingPath
        #endif
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
        // Force-evaluate the lazy `static let` so URLProtocol.registerClass
        // runs exactly once for the lifetime of the process. Reading the
        // value here (even unused) is the simplest way to drive Swift's
        // dispatch_once-backed static init; we deliberately don't gate on
        // a Bool because the language guarantees at-most-once already.
        _ = Self._mediaUrlProtocolInstalled
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
