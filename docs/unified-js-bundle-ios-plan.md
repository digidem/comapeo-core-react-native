# Ultra plan — Implementing `build-architecture-plan.md`, unifying the iOS JS bundle, and adding an iOS smoke test

## 0. Scope and framing

The full plan in [`docs/build-architecture-plan.md`](./build-architecture-plan.md) is a four-phase migration that ends in `jniLibs`/xcframework packaging plus an integrated smoke harness. **This branch (`claude/unified-js-bundle-ios-xVF6N`) intentionally lands only the slice that unblocks everything else**:

| Source-plan phase | What we do in this branch |
| --- | --- |
| Phase 1 — iOS parity in `scripts/build-backend.ts` | **Land in full.** This is the "unified JS bundle" deliverable. |
| Phase 2 — `assets → jniLibs/xcframework` packaging migration | **Out of scope.** Tracked separately, blocked on Phase 1 landing. |
| Phase 3 — Assembled-backend smoke test | **Land the iOS half.** Android smoke test covered by follow-up (`example/tests/android/` already has the lifecycle scaffolding). |
| Phase 4 — `socket-transport.js` extraction | **Out of scope.** Optional and orthogonal. |

The "switch iOS to use the same JS bundle as Android" sentence in the task is exactly Phase 1 of the source plan, and the smoke test is the iOS half of Phase 3. Everything else from the source plan stays on the roadmap but is explicitly not touched here.

**Simulator-only for Phase 1.** This branch ships iOS support for the simulator slices only (`arm64-simulator` for Apple Silicon hosts, `x86_64-simulator` for Intel hosts and CI runners). Device builds (`ios-arm64`) are deferred to Phase 2, when the xcframework packaging migration provides a single multi-slice artifact per addon. Reasons:

- The smoke test runs on the simulator, so device slices are not on the critical path for the deliverable in this branch.
- Loose `.node` files for both device and simulator in the same Resources bundle would force a runtime branch on `TARGET_OS_SIMULATOR` plus extraction logic that Phase 2 throws away.
- iOS code-signing constraints (an embedded Mach-O without an xcframework wrapper) bite differently on device vs. simulator. Solving both at once duplicates work that the xcframework migration solves uniformly.

A device build attempted against this branch will fail at link/launch time with a missing-arch error — that's the intended failure mode until Phase 2 lands. CI runs simulator only.

---

## 1. Current divergence (the actual starting point)

What the explore pass surfaced that the source plan understates:

1. **iOS today does not ship the backend.** [`ios/nodejs-project/index.js`](../ios/nodejs-project/index.js) is an 89-line stub whose [`package.json`](../ios/nodejs-project/package.json) declares only three deps (`ensure-error`, `framed-stream`, `tiny-typed-emitter`). It opens `comapeoSocketPath` and `stateSocketPath`, accepts a `{type:"shutdown"}` message, and broadcasts `started`/`ready` to the state IPC. **It never imports `@comapeo/core`, never calls `createComapeo`, and never instantiates a `ComapeoRpcServer`.** Every JS-side `comapeo.listProjects()` call from the example app on iOS therefore fails (or hangs on a socket that has no server bound) — which is why no current iOS test calls into the manager.

2. **`ios/nodejs-project/` is a separate npm root** with its own lockfile, installed at pod-install time by a `script_phase` in [`ios/ComapeoCore.podspec:51-72`](../ios/ComapeoCore.podspec). The podspec itself flags this as a TODO: *"revisit this script_phase once the iOS/Android nodejs-project sync follow-up lands"*.

3. **Argv arity differs between platforms.**
   - Android: `["node", indexPath, comapeoSocketPath, controlSocketPath, dataDir]` (5 args).
   - iOS: `["node", jsPath, comapeoSocketPath, stateSocketPath]` (4 args — no `dataDir`).
   - The real backend ([`backend/index.js:17-18`](../backend/index.js)) destructures `[comapeoSocketPath, controlSocketPath, privateStorageDir]`. So **iOS is missing the third positional arg the unified bundle needs**.

4. **Naming drift in the second socket.** The shared `backend/index.js` calls it `controlSocketPath`. iOS Swift calls it `stateSocketPath` (and the state-IPC server even renames the readiness phase). Once iOS uses the unified bundle, only one name survives — needs to be reconciled in both Swift and the JS state-IPC consumer (currently iOS-only behaviour: late-connect replay of `started`/`ready`).

5. **`build-backend.ts` is Android-only.** [`scripts/build-backend.ts:18,164,181`](../scripts/build-backend.ts) hardcodes `android/src/main/assets/...`. There is no iOS-side equivalent: iOS just trusts whatever a developer last typed into `ios/nodejs-project/`.

6. **`KEEP_THESE_FROM_BACKEND` includes drizzle migrations and the default-categories `.comapeocat` zip** ([`scripts/build-backend.ts:56-89`](../scripts/build-backend.ts)). These need to land on iOS too — the backend's `MIGRATIONS_FOLDER_PATH` ([`backend/index.js:11-13`](../backend/index.js)) reads `.sql` files from disk at runtime.

7. **Late-connect replay is iOS-only behaviour today.** The Swift `ServiceLifecycleTest` ([`example/tests/ios/ServiceLifecycleTest.swift:84-118`](../example/tests/ios/ServiceLifecycleTest.swift)) tests it; the regression was fixed in `ios/nodejs-project/index.js` only. When we unify, we either (a) port that behaviour into `backend/index.js` so all platforms benefit, or (b) drop the requirement after confirming iOS no longer needs it (the state-IPC client can connect synchronously after `node::Start` returns now that we control startup ordering). Decision deferred to the implementation step (§3.4) — likely (a) for safety since macOS-Sim timing differs from device.

---

## 2. End state for this branch

After this branch lands and merges:

- A single `backend/dist/index.mjs` is the source of truth for *both* platforms. `ios/nodejs-project/` ceases to be a hand-edited tree; it becomes a generated artifact (or is deleted entirely in favour of bundling the same `nodejs-assets/nodejs-project/` directory the script already produces).
- `npm run build:backend` (or however the script is invoked today — currently directly via `tsx`/node-tsm) produces `android/src/main/assets/nodejs-project/` **and** an iOS-targeted equivalent.
- Swift starts node with the same argv shape Android uses, adapted only where iOS-specific paths differ (private-storage dir derived from `NSFileManager.default.urls(for: .applicationSupportDirectory, ...)`).
- An iOS XCTest (`CoreManagerSmokeTest.swift`) launches the example app, waits for the runtime to come up, and asserts that the JS-side `comapeo.listProjects()` returns successfully — proving the embedded `ComapeoManager` instantiated, drizzle migrations ran, and the RPC roundtrip works. This is the "creates a CoMapeo core manager instance" contract.
- The pod-install `script_phase` that runs `npm install --omit=dev` in `ios/nodejs-project/` is deleted. Native deps in the unified bundle ship pre-installed in `nodejs-assets/`.
- Native addons still extract from the resource bundle to a working dir at first launch (Phase 2 of the source plan replaces this with xcframeworks; not here).
- iOS CI in `.github/workflows/ios-tests.yml` runs the new smoke test on a simulator destination.
- **Simulator-only.** The example app builds and runs on iOS simulators (Apple Silicon and Intel). Device builds intentionally fail until Phase 2 lands xcframework packaging that supplies the `ios-arm64` slice alongside the simulator ones.

Non-goals (deliberately deferred):

- xcframework packaging of `.node` files. iOS still receives loose `.node` prebuilds and copies them out at runtime, mirroring what Android does today. Phase 2 of the source plan replaces both.
- `jniLibs/` migration on Android.
- Stdio-pump `pthread_join` fix on Android (`docs/build-architecture-plan.md` §0.4 / Phase 2 step 5).
- `socket-transport.js` extraction.
- Per-module `better-sqlite3` iOS prebuild fix — that's a per-module-repo change, not this repo's.

---

## 3. Implementation plan

Five steps; ~2–3 days of focused work. Each step ends in a runnable checkpoint.

### Step 1 — Extend `scripts/build-backend.ts` to emit iOS outputs

**Files touched:** `scripts/build-backend.ts`.

1. Introduce an `IOS_ASSETS_DIR = ios/nodejs-project` constant alongside `ANDROID_ASSETS_DIR`. (Keep the existing path; just stop hand-editing it.)
2. After the rollup + `KEEP_THESE_FROM_BACKEND` copy currently lands in `TEMP_NODEJS_ASSETS_NODEJS_PROJECT_DIR`, add a second `cpSync` that copies that same directory into `IOS_ASSETS_DIR`. **This is the unification.** A single source dir, two destinations.
3. Add `IOS_ARCHS = ["arm64-simulator", "x64-simulator"] as const` (simulator-only — see §0) and a parallel artifact-fetch loop. Use the same `digidem/<name>-nodejs-mobile` GH release pattern; output naming will be `${name}-${version}-ios-${arch}.tar.gz` (matches the existing per-module workflow). Land prebuilds in `ios/nodejs-native/<arch>/node_modules/<pkg>/prebuilds/...` to match Android's structure 1:1. (In Phase 2 of the source plan these will be wrapped into xcframeworks alongside the device slice; for now loose simulator `.node` files keep this branch tractable.) The `ios-arm64` device slice is deliberately omitted — Phase 2 adds it.
4. Mirror the better-sqlite3 special-case (writes to `node_modules/better-sqlite3/build/`).
5. Delete `ios/nodejs-project/{package.json,package-lock.json,index.js,lib,types,tsconfig.json}` from git in the same commit. After this step the directory exists only as a build artifact.
6. Add `ios/nodejs-project/` and `ios/nodejs-native/` to `.gitignore`.
7. Update the existing TODO in [`ios/ComapeoCore.podspec:47-50`](../ios/ComapeoCore.podspec) and **delete the `script_phase`** (lines 51-72): the unified bundle ships with `node_modules` already populated by `build-backend.ts`. Keep `s.resources = 'nodejs-project'` and add `s.resources = ['nodejs-project', 'nodejs-native']` so loose `.node` files land in the bundle too.

**Checkpoint:** `npm run build:backend` (or the equivalent invocation; check `package.json` scripts and add a script if absent) creates both `android/src/main/assets/nodejs-project/` and `ios/nodejs-project/` from the same rollup output. Diff the two directories — they should be byte-identical except for any platform-conditional files (none expected today).

### Step 2 — Reconcile argv and socket naming

**Files touched:** `ios/AppLifecycleDelegate.swift`, `ios/NodeJSService.swift`, `ios/ComapeoCoreModule.swift`, `backend/index.js`.

1. In `NodeJSService.swift`:
   - Add a `privateStorageDir: String` parameter to `init` and stash it.
   - Rename `stateSocketPath` → `controlSocketPath` everywhere in the file. (The state-IPC role doesn't change — only the name aligns with the shared backend.)
   - Update `runNode()` (line 166-188) to pass `["node", jsPath, comapeoSocketPath, controlSocketPath, privateStorageDir]`.
2. In `AppLifecycleDelegate.swift`:
   - Compute `privateStorageDir` from `FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!.appendingPathComponent("comapeo").path`. Create the directory if missing (mirror Android's `getFilesDir()` semantics — `applicationSupportDirectory` is the closer analogue than `documentsDirectory` because it's not user-visible).
   - Pass it into the `NodeJSService` init.
   - Update `resolveJSEntryPoint` to look up `index.mjs` (not `index.js`) since the rolled-up bundle is ESM.
3. Port the late-connect replay behaviour into `backend/index.js`:
   - Today `backend/index.js` doesn't have any state IPC at all; it only has the comapeo RPC server and a `SimpleRpcServer` for shutdown. The iOS `state.sock` semantics (broadcast `started`/`ready`, replay on late connect) live only in `ios/nodejs-project/index.js`.
   - Move the `readinessPhase`/`controlClients` logic into `backend/lib/simple-rpc.js` (or a new sibling `lib/control-server.js`), so the unified bundle emits `started`/`ready` on the control socket regardless of platform. Android's [`NodeJSIPC.kt`](../android/src/main/java/com/comapeo/core/NodeJSIPC.kt) doesn't currently consume these but will tolerate extra messages — confirm by reading the JSON parser's behaviour on unknown `type` values.
4. Update Swift state-IPC consumer to keep listening for `started`/`ready` from the new path.
5. In `ios/ComapeoCoreModule.swift`, update any `stateSocketPath` references.

**Checkpoint:** Build the example iOS app, launch on simulator, observe in Xcode console that the rolled-up backend prints `Starting Comapeo Node server...` and `Node server listening on …` (the message in [`backend/index.js`](../backend/index.js) — slightly different wording than the iOS stub, which is a useful canary that the unified bundle is in fact running). The example app's `comapeo.listProjects()` call should return `[]` instead of hanging.

### Step 3 — Add the iOS smoke test

**Files touched:** new `example/tests/ios/CoreManagerSmokeTest.swift`, possibly tweaks to `example/App.tsx` for a programmatically observable test affordance.

The smoke contract is: *"the app builds, loads, and creates a CoMapeo core manager instance."* Three observable signals correspond:

1. **Builds.** `xcodebuild test ...` succeeds without compile errors. Free — the test target compiling is the proof.
2. **Loads.** `NodeJSService` reaches `.started` and `started`/`ready` arrive on the control socket. Already covered by `ServiceLifecycleTest.swift`; we'll reuse `waitForStarted()`.
3. **Creates a CoMapeo core manager instance.** This is the new bit. We need an end-to-end roundtrip that proves the JS-side `ComapeoManager` was constructed (which forces drizzle migrations to run, sodium-native to load, sqlite to open, etc.).

Two ways to hit (3):

- **Option A — call into the running node from Swift directly via the comapeo socket.** Frame a minimal RPC request (the same `MessagePort`/length-prefixed-JSON shape Kotlin uses), send `listProjects` or another idempotent read, parse the reply. Pros: no JS-side dependencies, fast. Cons: re-implements the framing in Swift test code; brittle if the wire format evolves.
- **Option B — drive the example app's existing JS code path and observe via UI / `XCUITest` or via a JS-side test affordance.** The example's `App.tsx:11-12` already calls `comapeo.listProjects().then(setProjects)` and renders count. An XCUITest can wait for a `testID="header"` element plus a sibling that renders the project count with a known accessibility identifier.

**Recommend Option A** for this branch: smaller surface, no XCUITest dependency, runs in the same XCTest target as `ServiceLifecycleTest`, fast enough to gate every PR. Option B is a good follow-up once we have an accessibility-instrumented example screen. Option A also matches what Android's instrumented tests do.

**Sketch of `CoreManagerSmokeTest.swift`:**

```swift
import XCTest
@testable internal import ComapeoCore

final class CoreManagerSmokeTest: XCTestCase {
    private var service: NodeJSService { AppLifecycleDelegate.nodeService }

    func testManagerInstantiatesAndRespondsToListProjects() throws {
        // 1. Loads. Reuse ServiceLifecycleTest's pattern.
        if service.state != .started { service.start() }
        let started = expectation(description: "started")
        service.onStateChange = { if $0 == .started { started.fulfill() } }
        if service.state == .started { started.fulfill() }
        wait(for: [started], timeout: 30)

        // 2. Creates a manager. Send one comapeo-rpc request and assert the
        //    framed reply parses as JSON. The success path forces the JS
        //    side to construct ComapeoManager (createComapeo) lazily on
        //    first request, which exercises:
        //      - drizzle migrations from MIGRATIONS_FOLDER_PATH
        //      - sodium-native dlopen
        //      - better-sqlite3 dlopen + DB open
        //      - the @comapeo/core constructor
        let ipc = NodeJSIPC(socketPath: service.comapeoSocketPath) { _ in }
        defer { ipc.disconnect() }
        waitUntil(timeout: 15, "comapeo IPC connected", ipc.state == .connected)

        let replyArrived = expectation(description: "list-projects reply")
        var replyJSON: String?
        ipc.onMessage = { msg in replyJSON = msg; replyArrived.fulfill() }
        // Wire format mirrors backend/lib/comapeo-rpc.js — cross-check
        // shape against ComapeoRpcServer when implementing.
        ipc.sendMessageSync(#"{"id":"smoke-1","method":"listProjects","params":[]}"#)
        wait(for: [replyArrived], timeout: 30)

        let data = try XCTUnwrap(replyJSON?.data(using: .utf8))
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(obj?["id"] as? String, "smoke-1")
        XCTAssertNil(obj?["error"], "manager construction must not surface an error")
        // listProjects returns `result: []` on a fresh install.
        XCTAssertNotNil(obj?["result"])
    }
}
```

This test has to run **before** `ServiceLifecycleTest`'s "graceful shutdown" phase (which terminates Node). XCTest's alphabetic ordering puts `CoreManagerSmokeTest` before `ServiceLifecycleTest` already, but this should be an explicit comment in both files since the once-per-process constraint makes ordering load-bearing.

**Mock RPC method names should be cross-checked** against `backend/lib/comapeo-rpc.js` before writing the test — `listProjects` is the obvious candidate but the actual method name on the wire might differ (`list-projects`, etc.).

**Checkpoint:** `cd example && npm run test:ios` exits 0 with the new test reporting "manager instantiates and responds to list-projects" in the Xcode test report.

### Step 4 — Update `ios-tests.yml` workflow

**Files touched:** `.github/workflows/ios-tests.yml`.

1. Add a new step **between** "Install dependencies" and "Download NodeMobile":
   ```yaml
   - name: Build backend bundle
     run: npm run build:backend
   ```
   This both proves Step 1 ran cleanly in CI and primes `ios/nodejs-project/`.
2. Delete the now-redundant `Install Node.js project dependencies` step (line 63-64) — Step 1 makes it unnecessary.
3. Leave `Download NodeMobile` in place; that's `NodeMobile.xcframework` (the Node runtime), which is separate from the addon prebuilds.

**Checkpoint:** Push the branch, watch the iOS Tests workflow go green.

### Step 5 — Documentation

**Files touched:** `docs/build-architecture-plan.md` (small annotation), `agents.md` (or wherever the canonical "how to run tests" section lives), this plan file.

1. In `docs/build-architecture-plan.md`, append a one-line Phase 1 status update:
   `> **2026-04-27**: landed in <PR-link>. iOS now consumes the same rolled-up backend as Android; `ios/nodejs-project/` is generated. Phase 2 (`jniLibs`/xcframework packaging) remains pending.`
2. Update any "iOS development" docs that reference the old hand-edited `ios/nodejs-project/` flow.

---

## 4. Risks and what to watch for

1. **Resource bundle layout differences.** CocoaPods' `s.resources` flatten/preserve behaviour is fragile (the existing podspec comment on line 35-40 already calls this out). Verify after Step 1 that `Bundle.main.path(forResource: "index", ofType: "mjs", inDirectory: "nodejs-project")` resolves — note the extension changes from `.js` to `.mjs` because the rolled-up output is ESM. `AppLifecycleDelegate.swift:47` needs the `ofType` update.

2. **`drizzle/` directory must be readable from the bundle.** iOS bundles are read-only. `MIGRATIONS_FOLDER_PATH` in `backend/index.js:11` resolves at JS evaluation time relative to `index.mjs`'s URL — that should work inside a bundle since drizzle reads via `fs.readFile`. But if anything inside `@comapeo/core` writes to that directory (lockfile, journal), it'll fail with `EROFS` at runtime. Worth a quick read of `@comapeo/core`'s migration runner to confirm. If it does write, copy the migrations dir to `applicationSupportDirectory/comapeo/migrations` on first launch (mirror Android's `copyAssetFolder` pattern minimally). **Do not generalize this into a full asset-extraction layer** — that's the path of regret the source plan §6 warns against. Just one targeted copy if needed.

3. **Once-per-process constraint vs. test ordering.** Step 3's smoke test must run before `ServiceLifecycleTest`'s shutdown phase. If alphabetic ordering is violated by a future test, the smoke test silently turns into a no-op (Node already exited). Belt-and-braces: either rename to ensure ordering, or add a precondition `XCTAssertEqual(service.state, .started)` so the failure is loud.

4. **Native-prebuild URL mismatch for iOS.** The per-module GH release naming convention for iOS slices may not exactly match the assumption in Step 1.3. Before writing code, fetch one URL by hand for `sodium-native` to confirm — for both `arm64-simulator` and `x86_64-simulator`. If the convention differs, treat it as a per-module-repo issue and unblock by tagging the missing release; do not paper over with arch-specific switch statements in `build-backend.ts`. Device-slice (`ios-arm64`) availability is **not** required for Phase 1 — those releases can lag without blocking this branch.

5. **Node 18 module-loading edge cases on iOS.** The Android side has been exercising the rolled-up bundle in production; iOS hasn't. Possible surfaces: ICU data path, TZ data, `process.platform === 'ios'` checks anywhere in `@comapeo/core`'s deps. None are known broken — flagging as the most likely source of "works on Android, doesn't on iOS" surprises during Step 2's checkpoint.

6. **CocoaPods caching.** After deleting the `script_phase` and hand-edited files, CocoaPods may still copy a stale `node_modules/` from a previous install if developers don't `pod deintegrate && pod install`. Add a one-line note to `agents.md` / iOS dev docs.

7. **Late-connect replay regression.** The behaviour the iOS-only state IPC ships today (regression-tested by `ServiceLifecycleTest`'s "late state-IPC receives started/ready" activity, `commit b3634de`) needs to ride along into `backend/index.js`. If it doesn't, the iOS smoke test's IPC connect — which races against node startup — may fail on slow simulator runs. Step 2.3 handles this; do not skip it.

---

## 5. Order of commits on this branch (recommended)

1. `chore: extend build-backend.ts to emit iOS bundle` — Step 1 only; CI green for Android, iOS unchanged but `ios/nodejs-project/` deleted from VCS.
2. `feat(ios): pass privateStorageDir + reconcile control socket name` — Step 2's Swift changes.
3. `feat(backend): port late-connect replay into shared control-server` — Step 2's JS changes.
4. `feat(ios): use rolled-up backend/dist/index.mjs as entry point` — flips the entry-point resolution; the example app now hits the real backend.
5. `test(ios): add CoreManagerSmokeTest` — Step 3.
6. `ci(ios): build backend bundle in CI; drop pod-install npm step` — Step 4.
7. `docs: annotate Phase 1 complete in build-architecture-plan.md` — Step 5.

Each commit is individually buildable and reviewable; (4) is the load-bearing one.

---

## 6. Acceptance criteria

- [x] `git ls-files ios/nodejs-project/` returns nothing (directory is purely generated; `.gitignore` covers it).
- [ ] `cd example && npm run test:ios` passes locally on macOS-15 with Xcode 26 against a simulator destination. _(unverified — depends on iOS prebuild availability per per-module repo; CI run after push will tell us)_
- [ ] `.github/workflows/ios-tests.yml` integration job passes the new `CoreManagerSmokeTest` on `iphonesimulator`. _(pending CI run)_
- [ ] `xxd android/src/main/assets/nodejs-project/index.mjs | head` and `xxd ios/nodejs-project/index.mjs | head` produce identical output. _(byte-equivalent by construction since both `cpSync` from the same `TEMP_NODEJS_ASSETS_NODEJS_PROJECT_DIR`; verify after first successful CI run)_
- [ ] Example app on iOS simulator (both `arm64-simulator` on Apple Silicon and `x86_64-simulator` on Intel/CI): `comapeo.listProjects()` returns `[]` (not a hang, not an error). _(pending end-to-end run)_
- [ ] Device build (`-sdk iphoneos`) deliberately fails with a missing-arch error — confirms Phase 1 scoping is honest. (Phase 2 fixes this.) _(unverified)_
- [x] `ios/ComapeoCore.podspec` no longer contains the `script_phase` block.
- [~] ~~No new asset-extraction logic on iOS~~ — superseded. The rolled-up bundle and per-module `prebuilds/` ship as separate read-only resource trees; Node's addon resolver expects them merged. `AppLifecycleDelegate.prepareNodeBundle()` extracts both into Application Support and overlays the active simulator slice. Mirrors Android's runtime asset copy in `NodeJSService.kt`.

## 7. Phase 2+ follow-ups

Items called out during review of Phase 1 that are deliberately deferred. Treat this as a backlog seed — convert into issues when each becomes top-of-stack.

### Phase 2 (xcframework + device support)

> **Status (2026-04-28):** Shipped via PR #16 / `e34505d`. See
> [`phase-2-xcframework-plan.md`](./phase-2-xcframework-plan.md) for
> the implementation. Per-addon xcframeworks now ship via Embed & Sign,
> the runtime overlay step is gone, and device + simulator are both
> supported in one artifact per addon. Real-device runtime test still
> open (see Phase 2.5 below). The Android counterpart is split into a
> dedicated plan:
> [`phase-2-android-jnilibs-plan.md`](./phase-2-android-jnilibs-plan.md).

- [x] ~~**Replace `#if arch(arm64)` with `#if targetEnvironment(simulator)`** in `AppLifecycleDelegate.prepareNodeBundle()`.~~ Moot — `prepareNodeBundle()` no longer does arch selection. The `#if` block was deleted along with `mergeDirectory()`; xcframeworks ship both arches and Xcode's selector handles per-destination slice picking.
- [x] ~~**Drop `nodejs-native/<arch>/` resource layout in favour of xcframework Embed & Sign.**~~ Done.
- [ ] **Smoke test on a real device.** Phase 1 covers simulator only; PR #16 added a CI device-build (codesign verification) but didn't add a runtime-on-device test. Keep open for Phase 2.5; needs provisioned hardware in CI.

### Phase 2.5 — runtime ergonomics

- [ ] **Gate `prepareNodeBundle()` on a version stamp.** Currently it deletes and re-copies the runtime tree on every cold start (~50 files / ~24 MB). Mirror Android's pattern: read `CFBundleVersion` (or the bundle executable mtime) on first launch, compare against a value in `UserDefaults`, skip the copy if they match. Saves tens of ms on every cold start.
- [ ] **Polyfill `globalThis.fetch` with `node-fetch@3`.** `--no-experimental-fetch` keeps Node's built-in undici-backed fetch out, but `@comapeo/core/src/member-api.js:496` calls the global `fetch` for invite hosting. Today that path crashes with `ReferenceError: fetch is not defined` if exercised on iOS. Wire `node-fetch` in via a banner-style init module so the polyfill runs before any module-level code that closes over `globalThis.fetch`. Smoke test does not exercise this; flag it in code review when invite flow lands on iOS.
- [ ] **Re-introduce the maps fastify plugin on iOS.** Currently the iOS rollup output stubs `@comapeo/core/src/fastify-plugins/maps.js` to a no-op (see `backend/lib/maps-stub.js`). Tile fetching is broken on iOS until either: (a) a non-WASM HTTP client replaces undici inside the maps plugin upstream, or (b) we ship a small iOS-specific maps plugin that uses the same `node-fetch` polyfill from the previous bullet. Decide upstream-or-downstream when stakeholders need iOS map tiles.
- [ ] **Stub a `console.warn` inside `backend/lib/maps-stub.js#plugin()`.** Today the no-op is silent — anyone routing a `/maps/*` request hits a 404 on iOS with no log indication that the plugin was stubbed at build time. One-line warn-on-register makes it observable.

### Phase 2.5 — defensive cleanup

- [x] ~~**Reorder smoke-test handler install (already done in Phase 1).**~~ Done in the Phase 1 review-fix PR.
- [x] ~~**Bound symlink follow in `mergeDirectory()`.**~~ Moot — `mergeDirectory()` was deleted in Phase 2 along with the rest of the runtime overlay.
- [ ] **Drop the silent dropping of `MapsPluginOpts` in the stub.** Once fetch is polyfilled (Phase 2.5), the stub can become a real (if minimal) plugin. Until then, surface unexpected register-time options as `console.warn` rather than silently discarding them.

### Cross-references for the deferred bucket

- The Phase 2 work itself: [`phase-2-xcframework-plan.md`](./phase-2-xcframework-plan.md) (iOS, shipped) + [`phase-2-android-jnilibs-plan.md`](./phase-2-android-jnilibs-plan.md) (Android, planned).
- The above Phase 2.5 list combined with the items in
  [`phase-2-xcframework-plan.md` §7](./phase-2-xcframework-plan.md#7-defer--out-of-scope)
  forms the full open backlog. When picking the next item to land,
  start there.
