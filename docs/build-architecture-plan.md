# Build architecture plan

Plan for improving how `comapeo-core-react-native` builds, links, and loads
native Node addons and backend JS. Companion doc:
[bare-architecture.md](./bare-architecture.md) explains how Bare does this —
this doc argues what to take from Bare, what to leave, and how to get there from
the current `nodejs-mobile`-based stack.

Scope is narrow on purpose: we are not building a general-purpose
`nodejs-mobile` wrapper. The six native modules we actually use are:

- [udx-native](https://github.com/holepunchto/udx-native)
- [simdle-native](https://github.com/holepunchto/simdle-native)
- [fs-native-extensions](https://github.com/holepunchto/fs-native-extensions)
- [rabin-native](https://github.com/holepunchto/rabin-native)
- [sodium-native](https://github.com/holepunchto/sodium-native)
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)

Constraints: robust and reliable; infrequent but feasible module upgrades; fast
feedback on whether a module builds and loads on each mobile arch, so we don't
iterate 30-min builds to discover failures.

---

## 0. 2026-04-24 update — validation results

The runtime loader mechanism below has now been validated end-to-end in
[`digidem/nodejs-mobile-bare-prebuilds`](https://github.com/digidem/nodejs-mobile-bare-prebuilds)'s
test harness (branch `feat/jnilibs-xcframework-packaging`, commit `a772cd0`). A
smoke test loading `quickbit-native` via jniLibs/mmap on Android and
xcframework/Embed-&-Sign on iOS passes `__NODE_EXIT__:0` on both platforms.

The plan text below is revised to match what actually works. Five deviations
from the earlier draft are worth calling out up front:

1. **On Android, `dlopen` must use a bare filename, not an absolute path.** With
   `extractNativeLibs="false"` the `.so` ships inside the APK mmap'd at load
   time; the path `getApplicationInfo().nativeLibraryDir` reports is a real
   directory but it contains nothing. A full-path
   `process.dlopen(mod, '/data/app/.../lib/x86_64/libsodium-native.so')` fails
   with `dlopen failed: library "…" not found`. Bionic's per-app linker
   namespace resolves bare names against the APK-mapped lib region, so
   `process.dlopen(mod, 'libsodium-native.so')` works. This is stronger than
   "pass the native-lib dir via argv" — on Android we don't need the dir at all.

2. **On iOS, a full path is still required.** `<app>.app/Frameworks/` is not on
   the default dylib search path, and the xcframework embed step nests the
   Mach-O inside `<name>@<version>.framework/<name>@<version>`. The JS side
   reads `NATIVE_LIB_DIR` (set to `[mainBundle].bundlePath/Frameworks` by
   AppDelegate before starting node) and builds
   `<libDir>/<name>@<version>.framework/<name>@<version>`.
   `install_name_tool -id "@rpath/<name>@<version>.framework/<name>@<version>"`
   before `xcodebuild -create-xcframework` so the Mach-O's install name matches
   the embedded layout. Versioned framework name is the default (matches the
   Android `lib<name>.<version>.so` convention), not just a multi-version
   special case.

3. **SONAME rewriting inside the ELF is not required for the single-version
   case.** The harness shipped `libquickbit-native.so` whose internal
   `DT_SONAME` was whatever the upstream build produced (not matching the
   on-disk filename), and Bionic loaded it fine via bare-name `dlopen`. Keep the
   `lib<name>.<version>.so` **filename** convention for multi-version
   coexistence, but don't bother `patchelf --set-soname`-ing unless a DT_NEEDED
   chain actually requires it. See [§3 Adopt](#adopt) and
   [§4.3](#43-source-of-truth-for-native-module-versions).

4. **Android stdio plumbing has a pthread_detach race.** `nodejs-mobile`'s
   reference Java wrapper pthread_detaches the stdout/stderr pump threads and
   calls `System.exit()` immediately after `startNodeWithArguments` returns.
   Uncaught-exception tracebacks on stderr are routinely lost to that race. Fix:
   close both descriptors of each stdio pipe's write-end after `node::Start`
   returns, `pthread_join` the pumps, then return control to Java for
   `System.exit`. Applies to any Kotlin/Swift code starting Node through the
   same JNI shape — the existing `NodeJSService.kt` copy likely has this bug
   too. See
   [native-lib.cpp reference](https://github.com/digidem/nodejs-mobile-bare-prebuilds/blob/feat/jnilibs-xcframework-packaging/test-harness/android/app/src/main/cpp/native-lib.cpp).

5. **A single `Module.prototype.require` patch is sufficient as the runtime
   intercept.** The harness validated this with one patch and no
   `require.extensions['.node']` fallback — the patch caught every loader
   pattern in `quickbit-native` / `node-gyp-build`. **[revised 2026-04-27]**
   The app plan uses only the rollup rewrite (Appendix C option A) — no
   runtime `require` patch. For the controlled set of six known modules with
   fully enumerated loader patterns (`bindings`, `node-gyp-build`,
   `require.addon`), build-time rewrites are sufficient and deterministic.
   The runtime patch adds maintenance cost (monkey-patching
   `Module.prototype.require`) without providing meaningful safety for a
   fixed dep set. Re-add if a future addon introduces an unrecognized loading
   pattern.

With those findings the rest of the plan stands; changes are inlined below
marked **[validated]** or **[revised]** where relevant.

---

## 1. Existing infrastructure we keep

Before proposing changes, the pieces that already work well:

- **`digidem/nodejs-mobile-bare-prebuilds`** reusable GitHub Actions workflows —
  `prebuild.yml`, `prebuild-all.yml`, `test-android.yml`, `test-ios.yml`,
  `release.yml`, plus composite actions (`prebuild`, `assemble-test-project`).
  Handles cross-compile, the Android NDK libc++ workaround,
  `-Wl,-z,max-page-size=16384`, simulator flags, patch-package style
  version-pinned patches, and emulator/simulator test runs. **[validated]** the
  `test-*.yml` workflows now also prove the jniLibs/xcframework loader path
  end-to-end, not just that the `.node` file builds and runs from `filesDir`.
- **`digidem/cmake-napi-nodejs-mobile`** — the fork of `cmake-napi` that makes
  it emit `nodejs-mobile`-ABI-compatible `.node` files and does not skip iOS
  (stock `cmake-napi` skips iOS entirely, see
  [bare-architecture.md §3.4](./bare-architecture.md#34-cmake-helpers)).
- **Per-module caller repos** (pattern: `digidem/<module>-nodejs-mobile`), each
  a thin wrapper containing a `CMakeLists.txt` (only required where upstream
  doesn't ship a bare-compatible one, so primarily `better-sqlite3`), a
  `patches/` directory, and a one-line workflow invoking the reusable pipeline.
  Published artifacts are tagged GitHub Releases.
- **`bare-make`** — thin wrapper over CMake/Ninja/Clang, used by the per-module
  workflow to handle cross-compile toolchain setup. Keep.
- **[scripts/build-backend.ts](../scripts/build-backend.ts)** — already does
  most of the install-time assembly for Android: rollup-builds the backend,
  copies JS + keep-listed non-JS (`KEEP_THESE_FROM_BACKEND`, e.g. drizzle
  migrations) into `android/src/main/assets/nodejs-project/`, and downloads
  `.node` prebuilds from GitHub Releases into
  `android/src/main/assets/nodejs-native/<abi>/`.

Gaps in the current state (the actual work to do):

- `build-backend.ts` handles Android only — no iOS asset/prebuild path.
- Native addons extract from APK assets to `filesDir` at first launch
  ([NodeJSService.kt:86-97](../android/src/main/java/com/comapeo/core/NodeJSService.kt#L86-L97)).
  Should move to `jniLibs/` (Android) and `.xcframework` (iOS) for
  zero-extraction loading and automatic code signing.
- `better-sqlite3` iOS build is not yet working in the per-module repo.
- No assembled-backend smoke test — individual module test workflows exist but
  nothing validates the full six-module set loading together inside
  comapeo-core-react-native's Node bootstrap.
- `NodeJSService.kt`'s JNI host has the pthread_detach / System.exit race
  described in §0.4 — same pattern that fails in the harness. Phase 2 step 5
  ports the fix.

---

## 2. IPC layer: keep what we have

The UDS boundary is the most portable piece of the current stack. Backend JS
([backend/index.js:19](../backend/index.js#L19)) takes `comapeoSocketPath` and
`controlSocketPath` as argv and listens on them; Kotlin
([android/src/main/java/com/comapeo/core/NodeJSIPC.kt:28-57](../android/src/main/java/com/comapeo/core/NodeJSIPC.kt#L28-57))
connects `LocalSocket` with 4-byte LE length-prefixed JSON framing
([backend/lib/message-port.js:32-49](../backend/lib/message-port.js#L32-L49)
mirrors this via `FramedStream`). Neither side knows the other exists beyond
"there is a unix socket here that speaks length-prefixed JSON".

Compare Bare's IPC
([react-native-bare-kit/index.js:12-105](../bare-reference-repos/react-native-bare-kit/index.js#L12-L105),
[shared/BareKitModule.cc](../bare-reference-repos/react-native-bare-kit/shared/BareKitModule.cc)):
a streamx Duplex backed by a JSI↔C pipe with `WOULD_BLOCK` flow control. Faster
— no socket syscalls, no JSON roundtrip if you want binary — but it's a
Bare-specific API tied to `bare_ipc_t`.

**Recommendation: keep UDS.** Given the goal of reserving the option of swapping
`nodejs-mobile` → Bare → static Hermes + JSI, UDS is the only IPC choice that
works across all three without a bridge rewrite:

| Runtime option          | How UDS keeps working                                               |
| ----------------------- | ------------------------------------------------------------------- |
| `nodejs-mobile` (today) | `net.createServer(path)` — what we have                             |
| Bare                    | `bare-pipe` supports AF_UNIX; swap `node:net` in the transport shim |
| Hermes + JSI            | ~50-line JSI module exposing AF_UNIX client API                     |
| Static Hermes           | Same as Hermes                                                      |

The transport-agnostic shape of
[backend/lib/message-port.js](../backend/lib/message-port.js) and
[backend/lib/simple-rpc.js](../backend/lib/simple-rpc.js) is right. The only
thing worth doing now to future-proof further is isolating the two `node:net`
usages ([backend/lib/server-helper.js:1](../backend/lib/server-helper.js#L1) and
the connection side) behind one `socket-transport.js` shim. Swap its
implementation later without touching anything else.

One thing worth borrowing from Bare's IPC: **flow control**. Our
`sendChannel = Channel(Channel.UNLIMITED)`
([NodeJSIPC.kt:36](../android/src/main/java/com/comapeo/core/NodeJSIPC.kt#L36))
and the message-port queue
([message-port.js:78-94](../backend/lib/message-port.js#L78-L94)) can grow
unboundedly if the backend is slow to drain. Bare's `WOULD_BLOCK`-driven Duplex
applies backpressure. Orthogonal to the runtime swap — worth fixing anyway, but
separate from build architecture.

---

## 3. What to take from Bare, what to leave

### Adopt

1. **`jniLibs/` (Android) and `.xcframework` (iOS) packaging for `.node`
   files**, replacing asset extraction. **[validated]** Android mmaps them from
   the APK with `android:extractNativeLibs="false"` +
   `packagingOptions.jniLibs.useLegacyPackaging=false`; iOS Embed & Sign handles
   code signing automatically with zero custom script phases beyond the
   xcframework slice-copy. Pattern lifted from Bare's `bare-link`
   ([bare-architecture.md §3.3](./bare-architecture.md#33-bare-link) and
   [§9](./bare-architecture.md#9-notable-design-choices)), simplified for our
   needs.
2. **Versioned filenames** for addons (`lib<name>.<version>.so` on Android,
   `<name>@<version>.framework` on iOS) so different versions can coexist. No
   DT_SONAME rewrite needed (see §4.3).
3. **Per-arch target matrix in CI** and the `module_spec`→`test-*.yml`→
   `release.yml` pipeline as a conceptual template for the assembled-backend
   smoke test in this repo (we need the _integrated_ version of what the
   prebuilds repo does per-module).

### Skip

- **Static-linking addons into `libnode`.** Considered; not chosen. Reasons in
  [appendix B](#appendix-b-static-linking-considered-not-chosen).
- **`bare-pack`.** Rollup already produces a single `.mjs` via
  [backend/rollup.config.js](../backend/rollup.config.js). `.bundle`'s only edge
  is the `linked:` addon-specifier trick; we handle addon resolution in our own
  rollup plugin.
- **`cmake-bare` auto-discovery of addons in `node_modules`.** We know our six
  addons; a hand-written list is clearer than "walk `node_modules` and find
  `"addon": true`".
- **`BareKit.Worklet` / JSI IPC.** UDS boundary is the portability asset — don't
  trade it for a faster but runtime-specific pipe.
- **Kit/app split.** Bare needs it because `bare-kit` is a reusable artifact; we
  don't — `comapeo-core-react-native` is the only consumer.

---

## 4. Target architecture

### Current state (recap)

- `nodejs-mobile` ships as a vendored `NodeMobile.xcframework` / `libnode.so`
  that knows nothing of addons.
- Addon prebuilds ship as assets
  (`android/src/main/assets/nodejs-native/<abi>/…`), downloaded at build time by
  [scripts/build-backend.ts](../scripts/build-backend.ts) and extracted to
  `filesDir` at first launch by
  [NodeJSService.kt:86-97](../android/src/main/java/com/comapeo/core/NodeJSService.kt#L86-L97).
- Backend JS bundles with rollup to a single `dist/index.mjs`, copied into
  `assets/nodejs-project/` alongside an allowlist of non-JS files (drizzle
  migrations etc., via `KEEP_THESE_FROM_BACKEND`).
- Loaders inside the bundle (`node-gyp-build`, `bindings`, `require-addon`) walk
  the filesystem, targeting paths rewritten by
  [backend/rollup-plugins/rollup-plugin-native-paths.js](../backend/rollup-plugins/rollup-plugin-native-paths.js).

### Proposed state

```
┌─ Per-module prebuild repos (digidem/<module>-nodejs-mobile) ──────────┐
│                                                                        │
│   Uses reusable digidem/nodejs-mobile-bare-prebuilds workflows:        │
│     prebuild.yml → bare-make generate/build/install                    │
│     test-*.yml   → module's own tests on emulator/simulator            │
│     release.yml  → publish prebuilds-*.tar.gz to GH Releases           │
│                                                                        │
│   Output: prebuilds/<target>/<name>.node  per target                   │
└────────────────────────────────────────────────────────────────────────┘
                                │
                ┌───────────────┴───────────────┐
                ▼                               ▼
   [GH Release per module]          [upstream npm tarball]
                │                               │
                └───────────────┬───────────────┘
                                ▼
┌─ This repo: scripts/build-backend.ts (extended) ──────────────────────┐
│                                                                        │
│   1. Read node-native/modules.json: which deps are native              │
│   2. Walk backend/node_modules post-install, resolving each named      │
│      module to its concrete (name, version) instances — including      │
│      multiple versions where npm couldn't dedupe                       │
│   3. For each (name, version): fetch prebuilds from the matching       │
│      digidem/<name>-nodejs-mobile GH Release tag                       │
│   4. For each target: place .so / xcframework per platform convention  │
│                                                                        │
│   Android:                                                             │
│     android/src/main/jniLibs/<abi>/lib<name>.<version>.so              │
│       (versioned filename for coexistence; mmap'd from APK at load)    │
│                                                                        │
│   iOS:                                                                 │
│     ios/Frameworks/<name>@<version>.xcframework                        │
│       (wraps .node as Mach-O framework; Embed & Sign handles codesign; │
│        install_name = @rpath/<name>@<version>.framework/<name>@<version>) │
│                                                                        │
│   Backend JS:                                                          │
│     rollup → dist/index.mjs + dist/index.mjs.map                       │
│     Staged to:                                                         │
│       android/src/main/assets/nodejs-project/                          │
│       ios/nodejs-project/                                              │
│     alongside KEEP_THESE_FROM_BACKEND (drizzle migrations, …)          │
└────────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─ Runtime ─────────────────────────────────────────────────────────────┐
│                                                                        │
│   Kotlin: startNodeWithArguments(["node", index.mjs path,             │
│     comapeoSocketPath, controlSocketPath, dataDir])                    │
│   Swift:  same args + NATIVE_LIB_DIR env var                           │
│     = [mainBundle.bundlePath]/Frameworks                               │
│   (Android does not need NATIVE_LIB_DIR — bare-name dlopen resolves    │
│   against the APK mmap namespace automatically.)                       │
│                                                                        │
│   JS bootstrap preloads each addon:                                    │
│     android: process.dlopen(mod, 'lib<name>.<version>.so')             │
│     ios:     process.dlopen(mod,                                       │
│                $NATIVE_LIB_DIR/<name>@<version>.framework/<name>@<version>) │
│   caches the handle, patches require('<name>') to return it.           │
│                                                                        │
│   IPC over UDS ↔ RN TurboModule — unchanged                            │
└────────────────────────────────────────────────────────────────────────┘
```

Key properties:

- **`.node` files never touch disk at runtime.** Android mmaps them from the
  APK's `lib/<abi>/`; iOS loads them from the signed framework in the app
  bundle. No `copyAssetFolder(NODEJS_NATIVE_ASSETS_DIRNAME, ...)`.
- **JS still extracts to `filesDir`** — this is correct and kept (see
  [§6](#6-javascript-asset-handling)).
- **Native module versions derive from the backend's dep tree**, not from a
  hand-maintained version list — source of truth stays in
  `backend/package.json` + `backend/package-lock.json` (via `@comapeo/core` and
  other deps). `node-native/modules.json` only records _which_ deps are native
  and where to find their prebuilds; versions are resolved post-install.
  Multi-version dep graphs are handled natively by the versioned-filename scheme
  (see [§4.3](#43-source-of-truth-for-native-module-versions)).
- **iOS code signing is free**: xcframeworks embedded via Xcode's standard
  "Embed & Sign" phase. No per-`.node` codesign script.
- **[revised]** **Android passes no native-lib dir via argv** — bare-name dlopen
  uses Bionic's linker namespace. iOS still exports `NATIVE_LIB_DIR` because
  `Frameworks/` isn't on the default dylib search path.
- **The `nodejs-mobile-bare-prebuilds` workflow suite stays untouched** — this
  repo is a _consumer_ of its GH Release artifacts.

### 4.3 Source of truth for native module versions

The version of every native addon is dictated by the backend's dep tree — not by
a hand-maintained list in this repo. A `sodium-native@5.2.1` choice belongs to
`@comapeo/core` (transitively); duplicating that version in our own manifest is
a second source of truth waiting to drift and break the ABI match between the JS
that calls the addon and the C++ that implements it.

**Model:**

```jsonc
// node-native/modules.json  (checked in, ~20 lines)
{
  "sodium-native": { "release_repo": "digidem/sodium-native-nodejs-mobile" },
  "udx-native": { "release_repo": "digidem/udx-native-nodejs-mobile" },
  "simdle-native": { "release_repo": "digidem/simdle-native-nodejs-mobile" },
  "fs-native-extensions": {
    "release_repo": "digidem/fs-native-extensions-nodejs-mobile",
  },
  "rabin-native": { "release_repo": "digidem/rabin-native-nodejs-mobile" },
  "better-sqlite3": { "release_repo": "digidem/better-sqlite3-nodejs-mobile" },
}
```

This lists _what is native_ and _where to find prebuilds_. Versions are absent
on purpose.

**Resolution** happens in `scripts/build-backend.ts`, post `npm install`:

1. For each module name in `modules.json`, enumerate every installed instance in
   `backend/node_modules/` — both the hoisted top-level install and any nested
   copies that npm couldn't dedupe. `npm ls <name> --all --json` gives this
   directly; equivalent can be walked by hand from `package-lock.json` or by
   `require.resolve.paths`.
2. Collect the distinct `(name, version)` set. For our six modules in a healthy
   dep graph this is usually exactly six entries; it's larger only if two
   backend deps pin incompatible ranges on the same native module.
3. For each `(name, version)`: fetch the matching prebuild tarball from
   `github.com/<release_repo>/releases/tag/v<version>` (or whatever tag scheme
   the per-module repo uses). Unpack into the expected per-ABI location with the
   versioned filename (Android) / xcframework name (iOS).

**Multi-version handling:**

- **Android**: versioned filename (`lib<name>.<version>.so`) in
  `jniLibs/<abi>/`. Each `require('name')` callsite in the rolled-up bundle is
  rewritten to the specific version's filename — rollup's `nodeResolve` already
  resolves physical module paths per-callsite. Runtime dlopen uses the bare
  filename (§8); no DT_SONAME rewrite (§0.3).
- **iOS**: versioned framework name (`<name>@<version>.xcframework`),
  symmetric with Android. `install_name_tool -id
  "@rpath/<name>@<version>.framework/<name>@<version>"` at wrap time. One rule
  across both platforms keeps the rollup rewrite and runtime preload uniform.
- **Require-call rewriting** (see
  [Appendix C](#appendix-c-addon-load-interception-strategies)) must preserve
  the version-specific resolution; a rewrite that collapses all
  `require('name')` callsites to a single basename silently breaks multi-version
  graphs.

**What changes at install time:**

- Today: prebuilds hosted on GH Releases, downloaded by `build-backend.ts`, laid
  out as assets. Versions implicit in what the download script happens to fetch.
- Proposed: same download source, but the **set of versions to fetch is computed
  from `node_modules`**, and the layout is `jniLibs/`/xcframework.

**Why this matters:**

- **No drift possible.** Bumping a backend dep that pulls a new `sodium-native`
  automatically triggers the new prebuild on next `npm run fetch-natives` — we
  can't forget to update a manifest line.
- **Multi-version safety.** Versioned filenames + resolve-per-callsite means if
  the dep graph ever does carry two majors of the same module, both ship
  correctly.
- **Per-module repos own their release tagging**. The convention
  "`digidem/<name>-nodejs-mobile` publishes `v<semver>` releases matching the
  upstream version" is the contract. A missing release for a resolved version is
  a loud failure with an actionable remediation (run the per-module prebuild-all
  workflow with that version).

**Edge case: a required version lacks a prebuild.** Fail loudly in
`build-backend.ts` with a message pointing at the relevant per-module workflow
dispatch URL. Don't silently fall back to a nearby version — ABI match is a
correctness property, not a hint.

### What stays the same (on purpose)

- UDS IPC boundary (the future-swap insurance).
- Rollup + `rollup-plugin-native-paths` as the JS build. Only the rewrite target
  changes (to a basename the JS bootstrap resolves at runtime via
  `process.dlopen`).
- Kotlin / Swift service layer, `ServerHelper`, `SimpleRpcServer`,
  `SocketMessagePort`.
- `ComapeoCoreModule` TurboModule and its event plumbing.
- `nodejs-mobile` as the runtime.

---

## 5. Migration plan

Phased so we get reliability first, iOS parity second, and smoke infrastructure
last (because the per-module workflows already cover most of the fast-feedback
story).

### Phase 1 — iOS parity in `scripts/build-backend.ts` (2–3 days)

> **2026-04-27, simulator-only:** landed on branch
> `claude/unified-js-bundle-ios-xVF6N`. iOS now consumes the same rolled-up
> backend as Android; `ios/nodejs-project/` and `ios/nodejs-native/` are
> generated by `npm run backend:build`. Device slice (`ios-arm64`) is
> deferred to Phase 2 (xcframework migration). See
> [unified-js-bundle-ios-plan.md](./unified-js-bundle-ios-plan.md) for the
> implementation breakdown. iOS simulator smoke test
> (`example/tests/ios/CoreManagerSmokeTest.swift`) verifies the embedded
> `ComapeoManager` instantiates end-to-end.

The script is Android-only today. Bring iOS up to the same functional shape
before changing packaging.

1. Add an `ios/nodejs-project/` target alongside
   `android/src/main/assets/nodejs-project/`. Same JS + same
   `KEEP_THESE_FROM_BACKEND` allowlist.
2. Add prebuild download for iOS targets (`ios-arm64`, `ios-arm64-simulator`,
   `ios-x86_64-simulator`). Still landing as loose `.node` files initially, to
   validate the download path independently of packaging changes.
   _Phase 1 ships only the two simulator slices; `ios-arm64` (device) is
   deferred to Phase 2 to avoid one-off codesign/runtime-branch work that
   the xcframework migration throws away._
3. Plumb the Swift side of `NodeJSService` to extract JS on first launch the
   same way Kotlin does, and start Node with the extracted `index.mjs` path.

Exit criterion: backend boots on iOS simulator with all six addons loadable
(even if still via loose `.node` extraction).

### Phase 2 — Packaging migration: assets → jniLibs/xcframework (3–5 days)

> **2026-04-28, complete:** Phase 2 ended up landing on a single
> branch (PR #16 grew to cover both halves) after a mid-stream
> simplification removed the @comapeo/core patch + free-form
> `__loadAddon` plumbing on iOS, which made the Android delta
> small enough to ride along.
>
> - **iOS:** per-addon `<name>__<version>.xcframework` (device + fat
>   simulator), Embed & Sign, multi-version `__loadAddon(name, version)`
>   rollup rewrite + banner. Detailed plan:
>   [`phase-2-xcframework-plan.md`](./phase-2-xcframework-plan.md).
> - **Android:** symmetric `jniLibs/<abi>/lib<name>__<version>.so`
>   layout with `extractNativeLibs="false"` + `useLegacyPackaging=false`.
>   Rollup loader plugin unified across platforms (one transform,
>   per-platform banner). Detailed plan:
>   [`phase-2-android-jnilibs-plan.md`](./phase-2-android-jnilibs-plan.md).
> - **Step 5 (JNI stdio drain fix)** stays deferred — packaging is
>   landed; the stdio drain fix is its own concern with a different
>   failure mode. Tracked in `phase-2-android-jnilibs-plan.md` §0
>   "What this branch deliberately doesn't ship".

The actual architectural shift. No longer depends on iOS build-backend parity
from phase 1 being _packaging-final_, just that JS loads.

1. Extend `scripts/build-backend.ts`:
   - Android: instead of writing to
     `android/src/main/assets/nodejs-native/<abi>/`, write to
     `android/src/main/jniLibs/<abi>/lib<name>.<version>.so`. No `patchelf` step
     — the validated harness showed filename-only uniqueness is sufficient.
     Mirror the `bare-link` Android pattern from
     [android.js:75-96](../bare-reference-repos/bare-kit/node_modules/bare-link/lib/platform/android.js)
     for inspiration, but drop the SONAME rewrite unless a DT_NEEDED issue
     actually surfaces.
   - iOS: wrap each `.node` as a Mach-O framework per arch with versioned
     name (`install_name_tool -id "@rpath/<name>@<version>.framework/<name>@<version>"`),
     `lipo` them per-OS, `xcodebuild -create-xcframework` into
     `ios/Frameworks/<name>@<version>.xcframework`.
2. Update [android/build.gradle](../android/build.gradle) to include the
   generated `jniLibs/` directory and set
   `packagingOptions.jniLibs.useLegacyPackaging = false`; set
   `android:extractNativeLibs="false"` in the manifest. Both are required for
   the bare-name dlopen path to resolve against the APK mmap region.
3. Update [ios/ComapeoCore.podspec](../ios/ComapeoCore.podspec) to embed the
   generated xcframeworks (`vendored_frameworks`). The Xcode Embed & Sign phase
   populates `<app>.app/Frameworks/` at build time; no custom Run Script phase
   needed.
4. Delete the native-asset branch of `copyAssetFolder` in
   [NodeJSService.kt:92-95](../android/src/main/java/com/comapeo/core/NodeJSService.kt#L92-L95)
   and the matching logic in the iOS service.
5. **[new]** Port the stdio-pump drain fix into `NodeJSService.kt`'s JNI host.
   After `node::Start()` returns:
   `close(STDOUT_FILENO); close(pipe_stdout[1]); close(STDERR_FILENO); close(pipe_stderr[1]); pthread_join(...)`.
   Remove `pthread_detach`. Without this, uncaught-exception tracebacks from the
   backend are routinely lost and load failures are invisible in logcat.
6. **[revised]** Update `rollup-plugin-native-paths` to rewrite the three loader
   patterns (`bindings`, `node-gyp-build`, `require.addon`) to call a single
   injected `__loadAddon(name, version)` helper. No runtime
   `Module.prototype.require` patch — all six modules have fully enumerated
   loader patterns, so build-time rewrites are deterministic and sufficient.
   The helper dispatches by platform:
   - android: `process.dlopen(mod, 'lib<name>.<version>.so')` — bare filename,
     no directory
   - ios: `process.dlopen(mod, path.join(NATIVE_LIB_DIR, '<name>@<version>.framework/<name>@<version>'))`

   Swift passes `NATIVE_LIB_DIR` env var before starting node; Kotlin passes
   nothing extra. See
   [Appendix C](#appendix-c-addon-load-interception-strategies) for the
   rationale and full helper sketch.
7. Run the (phase-3) assembled-backend smoke test, or for now just launch the
   app and confirm the six addons still work.

Exit criterion: `.node` files no longer exist anywhere in `filesDir`, iOS
xcframeworks are codesigned by the normal Xcode pipeline, and the app functions
on both platforms.

### Phase 3 — Assembled-backend smoke test (1–2 days)

Per-module tests in `nodejs-mobile-bare-prebuilds` already validate each addon
in isolation. What's missing is a test that validates them together inside this
module's Node bootstrap.

1. Add `scripts/smoke/` containing a minimal Node entrypoint that `require()`s
   each of the six addons in order and exits 0 with a status line per addon.
2. Tiny Kotlin `SmokeTest` instrumentation test + Swift XCTest target that
   launches Node with the smoke bundle and captures stdout/stderr.
3. `scripts/smoke.sh [--arch <abi>]` wiring both into one command for the
   emulator and simulator.
4. CI matrix job in this repo running the smoke test on each target arch after
   every PR.

Exit criterion: one command tells us within ~3 minutes whether the assembled
backend loads all six addons on each target arch.

### Phase 4 — Runtime-swap prep (optional, parallelizable)

Extract `node:net` usage in backend into a single
`backend/lib/socket-transport.js`. One file to replace when switching runtimes
later. No user-visible change.

### Outstanding work in per-module repos (not phased, track separately)

- **`better-sqlite3` iOS**. Existing CMakeLists.txt in
  [digidem/better-sqlite3-nodejs-mobile](https://github.com/digidem/better-sqlite3-nodejs-mobile)
  builds for Android; the reusable workflow supports iOS; most likely issue is
  the vendored sqlite3 static lib's compile-time defines or the
  `if(target MATCHES "linux")` branch needs an iOS counterpart. Half-day spike.
- Any holepunch modules for which a `digidem/<module>-nodejs-mobile` caller repo
  doesn't yet exist — caller repo is ~20 lines given the reusable workflow.

---

## 6. JavaScript asset handling

**Recommendation: keep the current pattern.** Rollup produces a single
`dist/index.mjs`; the build script stages it plus `KEEP_THESE_FROM_BACKEND`
(drizzle migrations etc.) into the per-platform asset directory; `NodeJSService`
extracts to `filesDir` at first launch via `shouldCopyAssets()` checking
`lastUpdateTime`. Don't change this.

### Why not ship JS in-APK and load without extraction?

Considered and rejected. Reasons:

- **`nodejs-mobile` expects a filesystem path** for the entry script
  (`startNodeWithArguments(["node", "/path/to/index.mjs", ...])`). There's no
  published API for loading an entry bundle from an `AAsset_*` handle the way
  `bare-kit` does
  ([bare-android/.../MainActivity.kt:22](../bare-reference-repos/bare-android/app/src/main/java/to/holepunch/bare/android/MainActivity.kt#L22)
  passing `assets.open("app.bundle")` to `worklet.start`). Working around this
  with `-e <huge-string>` or stdin-piping is brittle.
- **The bundle is not self-contained.** `backend/index.js:11` explicitly
  references a runtime filesystem path for drizzle migrations:
  ```js
  const MIGRATIONS_FOLDER_PATH = fileURLToPath(
    new URL("./node_modules/@comapeo/core/drizzle", import.meta.url),
  );
  ```
  Drizzle reads `.sql` files from disk at migration time. Even if `index.mjs`
  itself could be evaluated from memory, those migrations have to live somewhere
  the library can `fs.readFile` them. Asset extraction is the straightforward
  answer.
- **The cost is trivial.** On first launch (or after app update), one
  single-file copy + a small tree of SQL files. Not a perceivable startup cost,
  and guarded by the `APK_LAST_UPDATE_TIME_KEY` SharedPreference so it doesn't
  re-run on every boot.
- **App-update atomicity is already handled.** `shouldCopyAssets()` keys off
  `PackageInfo.lastUpdateTime`; a new APK always triggers a clean re-copy.

### Why not bundle-split?

Don't. Bundle-splitting makes sense when:

- You want to defer loading part of the code (web: route-based code splitting).
  We load all backend code at boot.
- You want per-chunk caching (web: CDN delta updates). Our chunks ship inside
  the APK; there's no delta story.
- Different entry points need different dependency subsets (Bare sometimes ships
  `app.bundle` + `push.bundle` per
  [bare-android/app/build.gradle:47-71](../bare-reference-repos/bare-android/app/build.gradle#L47-71)
  for the Firebase push extension). We don't currently have a multi-entry use
  case; if a future push-handler entry point is added, that's the time to split
  — not before.

One big `index.mjs` is easier to reason about, easier to sourcemap, easier to
diff across releases. Stick with it.

### What can be simplified

The extraction step could be faster by emitting rollup output directly into the
staged asset directory instead of building then copying. Marginal. Only worth it
if `build-backend.ts` becomes a bottleneck.

The asset allowlist (`KEEP_THESE_FROM_BACKEND` in
[scripts/build-backend.ts:56](../scripts/build-backend.ts#L56)) is maintained by
hand — fine for now, but worth auditing each release that bumps `@comapeo/core`
or adds a backend dep, since silent breakage is easy (library reads a file, it's
not in the allowlist, runtime error).

---

## 7. Fast-feedback workflow

| Scenario                                | Phase 0 (today)                                | After phase 2                                           | After phase 3                                        |
| --------------------------------------- | ---------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------- |
| Adding a new addon to test feasibility  | 30-min rebuild + app launch, guess from logcat | Add to manifest, rerun `build-backend.ts`, launch app   | `./scripts/smoke.sh --arch android-arm64` (~3 min)   |
| Upgrading sodium-native                 | Hope the prebuild exists, full app rebuild     | Bump version in manifest, rerun fetch, full app rebuild | Same + smoke test validates before app rebuild       |
| Debugging a load failure on one ABI     | Build APK for all ABIs, install, grep logcat   | Same (jniLibs don't materially change debuggability)    | `smoke.sh --arch <abi>` prints dlopen error directly |
| Verifying CI after `nodejs-mobile` bump | Manual on-device tests                         | Manual                                                  | Smoke suite runs per-arch in CI                      |

Module-level fast feedback is **already solved** by
`nodejs-mobile-bare-prebuilds`'s `test-android.yml` / `test-ios.yml`. Phase 3 is
specifically the _integrated_ smoke — the thing we can't delegate to the
per-module repos.

---

## 8. Risks and callouts

- **[revised]** **Android dlopen needs a bare filename, not an absolute path.**
  With `extractNativeLibs="false"`, `getApplicationInfo().nativeLibraryDir`
  returns a real directory that contains nothing. A full-path `process.dlopen`
  or `System.load()` fails with "library not found" even though the `.so` is
  present and correctly stored in the APK. Pass just the filename
  (`lib<name>.<version>.so`); Bionic resolves it through the per-app linker
  namespace against the APK mmap region. When debugging a Phase 2 load failure,
  confirm this is wired right before chasing packaging or ELF issues.

- **[new]** **Stdio pump thread race on Android can mask errors.**
  `NodeJSService.kt`'s JNI shape (same pattern as nodejs-mobile's Java
  reference) pthread_detaches the stdout/stderr pumps and calls `System.exit()`
  immediately after `node::Start()` returns. When Node exits on an uncaught
  exception, the stderr traceback is in the pipe buffer; the pump thread hasn't
  flushed it to logcat when `System.exit()` kills the process. CI runs showed
  `__NODE_EXIT__:1` with no error output at all for this reason. Fix is in Phase
  2 step 5; ref implementation in
  [native-lib.cpp](https://github.com/digidem/nodejs-mobile-bare-prebuilds/blob/feat/jnilibs-xcframework-packaging/test-harness/android/app/src/main/cpp/native-lib.cpp#L58-L71).

- **`process.dlopen` vs runtime-loader intercept**: a linked-via-dlopen addon
  doesn't register an `.node` file extension handler. Packages that explicitly
  inspect a `.node` file path (some stack trace / debug-info code does this) may
  misbehave. Worth smoke-testing each of the six under realistic use, not just
  `require`-success. If any module breaks, fall back to having
  `preload-addons.js` place the loaded handle in `require.cache` under the same
  resolved path the module expects.

- **`--needs` flag behaviour**. `bare-link`'s `--needs libbare-kit.so` flag adds
  a `DT_NEEDED` so the ELF loader resolves runtime symbols against the kit lib.
  For us the equivalent is `libnode.so`. Verify with
  `readelf -d lib<name>.<version>.so | grep NEEDED` after the packaging pipeline
  runs in phase 2 — the prebuilds pipeline already gets this right for the
  targets the test harness smoke-tests, but worth a quick check per module.

- **iOS simulator architectures**. Phase 1/2 need both `ios-arm64-simulator`
  (Apple Silicon Macs) and `ios-x86_64-simulator` (Intel Macs + CI runners). The
  reusable workflow supports both; make sure `scripts/build-backend.ts`
  assembles both into the xcframework.

- **16KB page alignment**. [android/build.gradle](../android/build.gradle)
  already sets `-DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON` for its own native
  code, and `prebuild/action.yml` passes `-Wl,-z,max-page-size=16384` at addon
  build time. Verify Android 15+ 16KB-page device compatibility with
  `readelf -l | grep LOAD`.

- **Do not port to Bare as part of this work.** Treat it as a downstream option
  the plan preserves, not a current goal. The `socket-transport.js` extraction
  (phase 4) is the only thing that needs to happen now to keep that door open.

---

## Appendix A: corrections to earlier thinking

An earlier version of this plan proposed:

- Replacing `bare-make` with raw CMake calls.
- Building a central `node-native/` pipeline that clones each addon's source and
  static-links them into a custom `libnode`.
- Consolidating the six per-module prebuild repos into one monorepo.

All three are wrong for this project.

`bare-make` is a thin, well-scoped wrapper around CMake/Ninja/Clang that handles
cross-compile toolchain setup — the same work the `prebuild/action.yml`
composite action wraps into the reusable workflow. Replacing it is pure
overhead.

The per-module repos + `nodejs-mobile-bare-prebuilds` reusable workflows are the
right shape. Each caller repo is nearly template-thin. Consolidating would trade
six small repos for one large one and break "tagged GH release per module per
version", for no real build-pipeline simplification.

Static linking is covered in
[appendix B](#appendix-b-static-linking-considered-not-chosen).

A later version of this plan (superseded by §0) proposed:

- Passing an absolute `nativeLibDir` via argv on Android and calling
  `process.dlopen` against that path. Wrong — would fail at runtime with
  "library not found" under `extractNativeLibs="false"`.
- Rewriting `DT_SONAME` inside every Android `.so` to match the versioned
  filename. Unnecessary for the common case; adds a tool dependency (`patchelf`)
  and a build step with no observable effect on our workload.

---

## Appendix B: static linking (considered, not chosen)

Bare statically links every builtin addon into the kit library
([bare-architecture.md §4](./bare-architecture.md#4-static-vs-dynamic-linking--what-actually-happens)).
We could do the same for `nodejs-mobile`: fork libnode, link the six addon
static libs, call `node::AddLinkedBinding` for each, expose via
`process._linkedBinding('<name>')`.

Benefits we considered:

- Single artifact per platform (`libnode.so` / `NodeMobile.xcframework`).
- No runtime dlopen.
- Atomic ABI coupling — all addons rebuild together against a new node version.

Why we're not doing it:

- Once `.node` files are in `jniLibs/` / `.xcframework`, **the practical
  advantages of static linking mostly evaporate**. No asset extraction, iOS
  signing is free, AAB ABI-splits work, per-ABI mmap from APK. The remaining
  benefit is saving maybe ~50ms of dlopen at boot.
- **The cost is large.** A central `node-native/` build pipeline needs its own
  fork of `nodejs-mobile`, knowledge of each addon's build requirements
  reimplemented outside their per-module CMakeLists, and a CI matrix separate
  from (and duplicating much of) the `nodejs-mobile-bare-prebuilds`
  infrastructure we already have.
- **`better-sqlite3` would be particularly painful.** It's a standard `node-gyp`
  module with a heavy C++ stack (SQLite + better-sqlite3 glue). Getting it to
  static-link against `nodejs-mobile` headers in a monolithic build is not
  proven territory.
- **We lose per-module upgrade granularity.** Today, upgrading `sodium-native`
  means bumping one manifest entry and rerunning `build-backend.ts`. Under a
  static-link model, every bump triggers the full central rebuild.
- **The runtime-swap story gets worse.** If we ever move to Bare or
  Hermes-with-JSI, a vendored `libnode` is dead weight. Dynamic addons can be
  re-targeted; statically baked ones have to be pulled out and re-baked.

Revisit only if a concrete problem emerges (startup time measurably hurts, or we
hit an iOS code-signing edge case the xcframework path can't solve).

---

## Appendix C: addon load interception strategies

When we move `.node` files out of `filesDir` into `jniLibs/`/xcframework, we
need the backend's `require('sodium-native')` (and the other loader patterns) to
resolve to the new location. There are several ways to intercept this; this
appendix compares them and explains the chosen approach.

### Survey of options

**A. Bundle-stage rewrite (rollup plugin, the current mechanism).**

Extend
[rollup-plugin-native-paths.js](../backend/rollup-plugins/rollup-plugin-native-paths.js)
to replace the three known loader patterns with calls to a single addon-registry
helper:

- `require('bindings')({bindings: 'foo.node'})` → `__loadAddon('foo', version)`
- `require('node-gyp-build')(__dirname)` → `__loadAddon('foo', version)`
- `require.addon('.', __filename)` → `__loadAddon('foo', version)`

At bundle resolution time we know the resolved version per callsite (rollup's
`nodeResolve` walks `node_modules`), so each rewrite bakes in the correct
`lib<name>.<version>.so` basename. `__loadAddon` is a tiny injected runtime
helper that does platform-specific `process.dlopen` and caches.

**B. `require.extensions['.node']` override at runtime.**

```js
require.extensions[".node"] = (module, filename) => {
  const name = path.basename(filename, ".node");
  process.dlopen(module, resolveAddon(name));
};
```

Catches any caller that ends up doing `require('/abs/path/foo.node')`. Doesn't
catch `require('sodium-native')` directly — that resolves to the module's main
entry, which then dispatches through `bindings`/`node-gyp-build`/etc. (so A
handles the bare-name case).

**C. Monkey-patch `Module.prototype.require` / `Module._load`.**

Full interception of every `require()` call; check the id against a known-addons
map, return the preloaded handle if matched, else pass-through. Catches both
bare names and file paths. One Map lookup per `require()` call.

**[validated]** The test harness used exactly this — one
`Module.prototype.require` patch — and caught every loader pattern in
`quickbit-native` / `node-gyp-build`.

**D. Node's `module.register()` hook.** _Not available on Node 18._ Added in
Node 20.6. `nodejs-mobile` currently ships Node 18.20.4, so this is not an
option until `nodejs-mobile` catches up. Even then it's ESM-loader-only, doesn't
help with `.node` addon resolution.

**E. `--experimental-loader` ESM loaders.** Available in Node 18 but only covers
ESM module resolution, not CommonJS `require()` and not native addon loading.
Wrong layer.

**F. `patch-package` on the addon loaders inside `node_modules`.**

Commit patches to `node-gyp-build`, `bindings`, `require-addon` that change
their resolution strategy. The patched source flows through rollup naturally.

**G. Mutate `require.cache[require.resolve('require-addon')].exports`.**

Replace the exports object of a cached module so subsequent requires of the same
package see our version. Useful for `require-addon` specifically (bare-style),
but only catches one of three loader patterns.

**H. Build-time symlink layout.** Write `.node` files at the paths the stock
loaders expect, but actually symlink them to the `.so` in `jniLibs/`. Abandons
the architectural goal of getting `.node` out of `filesDir`.

### Comparison

| Option                           | Node 18? | Catches bare names | Catches file paths | Direct `process.dlopen` in 3rd-party code | Build-time deterministic | Complexity      |
| -------------------------------- | -------- | ------------------ | ------------------ | ----------------------------------------- | ------------------------ | --------------- |
| A. Rollup rewrite                | ✓        | ✓ via path rewrite | ✓ via path rewrite | partial (depends on pattern)              | ✓                        | medium          |
| B. `require.extensions['.node']` | ✓        | ✗ (indirect via A) | ✓                  | ✗                                         | ✗                        | low             |
| C. Monkey-patch require          | ✓        | ✓                  | ✓                  | ✗                                         | ✗                        | low             |
| D. `module.register()`           | ✗        | -                  | -                  | -                                         | -                        | -               |
| E. `--experimental-loader`       | ✓        | ✗ (ESM only)       | ✗                  | ✗                                         | -                        | -               |
| F. `patch-package`               | ✓        | via source         | via source         | ✗                                         | ✓                        | high maint.     |
| G. `require.cache` mutation      | ✓        | one loader only    | ✓ (same)           | ✗                                         | ✗                        | low, narrow     |
| H. Symlinks                      | ✓        | via source         | via source         | ✓                                         | ✓                        | low, regressive |

None of A–H catches a library that calls `process.dlopen(...)` directly against
a hard-coded path computed outside the three known loader patterns. In practice,
every addon in our dep set funnels through one of the three patterns (audited in
[rollup-plugin-native-paths.js:18-34](../backend/rollup-plugins/rollup-plugin-native-paths.js#L18-L34)).
If a future addon breaks that, we widen the rollup plugin.

### Chosen approach

**[revised 2026-04-27]** Choose **A only** (not A + C as previously planned).

**A (bundle-stage rewrite) is the sole mechanism**, because:

- It's **deterministic** — what ships is what the bundle shows, with no runtime
  mutation surprises.
- It handles **version-aware resolution**: the rewrite runs per-callsite with
  the resolved physical module path, so a multi-version dep tree gets the right
  `lib<name>.<version>.so` per callsite for free.
- It runs at **build time**, so errors (missing prebuild, unresolved basename)
  surface in CI rather than at first app launch.
- It extends code we already own.
- The three loader patterns (`bindings`, `node-gyp-build`, `require.addon`) are
  fully enumerated for all six known modules. There is no loading path the
  rollup plugin could miss for this dep set.

Dropping option C (Module.prototype.require patch) eliminates runtime
monkey-patching that carries real maintenance cost — an extra interception
point to debug when load failures surface — without providing meaningful
safety for a fixed, known dep set. If a future addon introduces an unrecognized
loading pattern, add option C then rather than carrying it speculatively.

```js
// Injected at bundle-head by rollup-plugin-native-paths
const PLATFORM = /* 'android' | 'ios' — substituted at build time */
const NATIVE_LIB_DIR = process.env.NATIVE_LIB_DIR /* ios only; unused on android */
const preloaded = new Map()

function __loadAddon(name, version) {
  const key = name + '@' + version
  if (preloaded.has(key)) return preloaded.get(key)
  const mod = { exports: {} }
  if (PLATFORM === 'android') {
    // Bare filename — Bionic's per-app linker namespace resolves it
    // against the APK's lib/<abi>/ mmap region. A full-path dlopen
    // would fail because extractNativeLibs="false" means the .so is
    // not on disk at any resolvable path.
    process.dlopen(mod, `lib${name}.${version}.so`)
  } else {
    process.dlopen(mod, require('path').join(
      NATIVE_LIB_DIR,
      `${name}@${version}.framework/${name}@${version}`
    ))
  }
  preloaded.set(key, mod.exports)
  return mod.exports
}

// Each native loader call in the bundle is rewritten by rollup-plugin-native-paths
// to a direct __loadAddon invocation. Example transforms:
//   require('node-gyp-build')(__dirname)          → __loadAddon('sodium-native', '5.2.1')
//   require('bindings')({bindings: 'foo.node'})   → __loadAddon('better-sqlite3', '9.6.0')
//   require.addon('.', __filename)                → __loadAddon('fs-native-extensions', '1.4.3')
// Version is resolved from the module's package.json at rollup transform time,
// so multi-version dep trees get the correct .so per callsite automatically.
```

### Options explicitly not chosen

- **C (Module.prototype.require patch)**: harness validation confirmed C is
  sufficient as a safety net, but for a fixed set of six known modules with
  fully enumerated loader patterns, the rollup rewrite (A) handles every
  callsite at build time. Carrying C speculatively adds a runtime interception
  point that is harder to debug when load failures surface. Re-add if a future
  addon introduces a loading pattern the rollup plugin cannot statically
  transform.
- **B (`require.extensions['.node']`)**: harness validation showed C does
  everything B would do and catches more. Neither is used in the current
  approach; both remain available as escalation options.
- **D (`module.register`)**: unavailable on Node 18.20.4 (added in 20.6.0).
  Revisit when `nodejs-mobile` updates the underlying Node version, but even
  then it's not the right layer for native addon interception.
- **F (`patch-package`)**: we already own the rollup plugin that sees all three
  loader patterns. Patching `node-gyp-build` / `bindings` / `require-addon` in
  place duplicates that work against upstream sources that might rev
  independently.
- **H (symlinks)**: abandons the architectural goal. Only a fallback if A + C
  turn out to have a gap we can't close.

### When to revisit

If Node 18 is upgraded in `nodejs-mobile`, re-evaluate **D**: the post-20.6
`module.register()` API can express this cleanly and lives on an official Node
extension point rather than a private rollup rewrite. The correctness story is
similar; the durability story is better.