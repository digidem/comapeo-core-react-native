# Phase 2 plan — Android `jniLibs/` packaging for native addons

Sequel to [`phase-2-xcframework-plan.md`](./phase-2-xcframework-plan.md)
(landed in PR #16). That branch migrated iOS to xcframework Embed & Sign
and explicitly punted the same architectural shift on Android. This plan
covers the Android side: move `.node` files out of
`android/src/main/assets/nodejs-native/<abi>/` (extracted at first
launch by `NodeJSService.kt#copyAssetFolder`) into
`android/src/main/jniLibs/<abi>/lib<name>.so`, mmap'd from the APK at
load time. Symmetric goal to the iOS work: zero runtime extraction,
automatic packaging by the toolchain, no `android.permission.WRITE_*`
on shared external state.

The runtime intercept also unifies as part of this branch: the
iOS-only `__loadAddon(name)` helper from PR #16 grows a
platform-dispatched body, and `rollup-plugin-native-paths.js` is
retired in favour of a single `rollup-plugin-addon-loader.js`.

---

## 0. Scope and framing

### What ships in this branch

- **`scripts/build-backend.ts`** writes per-addon `.so` files to
  `android/src/main/jniLibs/<abi>/lib<name>.so`. Drops the
  `android/src/main/assets/nodejs-native/<abi>/` write path.
  Filename convention is unversioned (`lib<name>.so`) to match the
  iOS plan's `<name>.framework/<name>` convention; multi-version
  handling deferred until a real need surfaces (canonical plan §4.3).
- **`android/build.gradle`** registers the new `jniLibs/` source set
  alongside the existing `libnode/bin/` one, and sets
  `packagingOptions.jniLibs.useLegacyPackaging = false`.
- **`android/src/main/AndroidManifest.xml`** sets
  `android:extractNativeLibs="false"` on `<application>` so the APK's
  `lib/<abi>/*.so` segment is mmap'd in place rather than extracted to
  `nativeLibraryDir` at install. This is the load-bearing change for
  bare-name `dlopen` to work — see canonical §0.1 and §8.
- **`android/src/main/java/com/comapeo/core/NodeJSService.kt`** drops
  the `nodejs-native/<abi>/` overlay step in `start()`. The remaining
  asset extraction is JS-only (a small tree — `index.mjs`, drizzle
  migrations, native-module `package.json`/`binding.gyp`); keep the
  `lastUpdateTime` gate.
- **`backend/rollup-plugins/rollup-plugin-addon-loader.js`** —
  unified successor to `rollup-plugin-ios-addon-loader.js`. Same
  rewrites; the runtime helper banner dispatches per-platform:
  - Android: `process.dlopen(mod, 'lib<name>.so')` — bare filename,
    Bionic's per-app linker namespace resolves it against the APK
    mmap region.
  - iOS: unchanged from PR #16 — `process.dlopen(mod,
    NATIVE_LIB_DIR + '/' + name + '.framework/' + name)`.

  `rollup-plugin-native-paths.js` is deleted in this branch. The
  unified plugin is set up to read its target platform from
  `rollup.config.js`, which already has two outputs.
- **`ComapeoManager`'s `betterSqlite3NativeBinding` now flows on
  Android too.** PR #16 plumbed the option through `@comapeo/core`'s
  patch-package patch but Android skipped passing it (the Phase 1
  asset path resolves better-sqlite3 via its filesystem walk). Once
  Android moves to `__loadAddon`, `backend/lib/create-comapeo.js`'s
  `globalThis.__loadAddon?.('better-sqlite3')` call resolves on
  Android too.

### What this branch deliberately doesn't ship

- **`NodeJSService.kt` JNI stdio pump drain fix** (canonical §0.4 / §8).
  Important — uncaught backend exceptions are routinely lost to the
  pthread_detach race today. But it's separable from packaging: the
  fix is in C++ JNI code (`pthread_join` instead of `pthread_detach`,
  `close` write ends after `node::Start` returns), and a regression
  there has a different failure shape (lost log lines) than a packaging
  regression (load-time crash). Bundling them risks diagnostic
  ambiguity if CI fails. Recommend: separate PR right after this one,
  same author, ideally before any externally-visible release.
- **Versioned `lib<name>.<version>.so` filenames.** Canonical §4.3
  describes the multi-version coexistence story. Six of our seven
  native modules are pinned at single versions in
  `backend/package-lock.json`; the seventh (`better-sqlite3`) is
  also single-version. Add `<version>` when we hit a real
  multi-version dep graph. Either approach is mechanical: filename
  in the build script + the same-named string in the rolled-up
  `__loadAddon` callsite.
- **Removing `assets/nodejs-project/` extraction entirely.** The JS
  bundle still copies on first launch (~50 files, ~24 MB). Phase 1
  review identified this as a Phase 2.5 follow-up. Out of scope
  here because the gate logic differs per platform (CFBundleVersion
  on iOS, lastUpdateTime + SharedPreferences on Android) and is
  worth keeping in one focused PR per platform.
- **iOS-side changes.** Phase 2 iOS already shipped. This branch
  edits one iOS file: the rollup config plumbing for the unified
  loader plugin. No behaviour change on iOS.

### Phase 2.5+ follow-ups (out of scope further still)

Inherited from `unified-js-bundle-ios-plan.md` §7 and unchanged here:

- iOS real-device runtime smoke test (currently CI only does a
  codesign-only `xcodebuild build` against `iphoneos`).
- Version-stamp gate on `prepareNodeBundle()` cold-start copy.
- iOS map-tile fetching re-introduction; `globalThis.fetch` polyfill;
  maps-stub `console.warn`.
- `mergeDirectory()` symlink hardening — already deleted in PR #16
  along with the rest of the overlay logic, so this is moot.
- 16 KB page alignment verification on Android 15+ (canonical §8).
  Probably already green via the `-Wl,-z,max-page-size=16384` flag
  in `nodejs-mobile-bare-prebuilds`'s `prebuild/action.yml`, but
  should be confirmed once with `readelf -l | grep LOAD` on the
  shipping `.so`s.

---

## 1. Current state (Phase 2 iOS / Phase 1 Android baseline)

```
android/
├── build.gradle               # jniLibs.srcDirs 'libnode/bin/' (libnode.so only)
├── libnode/                   # nodejs-mobile prebuilt libnode.so per ABI
├── src/main/
│   ├── AndroidManifest.xml    # no extractNativeLibs setting
│   ├── assets/                # generated by scripts/build-backend.ts (gitignored)
│   │   ├── nodejs-project/    # rolled-up backend (JS + drizzle + native pkg.json)
│   │   └── nodejs-native/     # Phase 1: per-ABI .node files extracted at launch
│   │       ├── arm64-v8a/.../*.node
│   │       ├── armeabi-v7a/.../*.node
│   │       └── x86_64/.../*.node
│   └── java/com/comapeo/core/
│       └── NodeJSService.kt   # copyAssetFolder(nodejs-native/<abi>) at start()
```

At launch, `NodeJSService.kt` checks `lastUpdateTime` against a
SharedPreference; on cold install or app upgrade, copies both
`assets/nodejs-project/` and `assets/nodejs-native/<abi>/` into
`filesDir`, overlaying so `.node` files land at
`nodejs-project/node_modules/<pkg>/prebuilds/android-<abi>/<name>.node`.
The rolled-up bundle's `rollup-plugin-native-paths.js` rewrites the
three loader patterns (`bindings`, `node-gyp-build`, `require.addon`)
to walk into those paths via the bare resolvers; `process.dlopen` ends
up loading from `filesDir` at the JS-level filesystem position.

Two limitations:

- **First-launch I/O cost.** Native binaries (~few MB total) extracted
  on cold install + every app upgrade. No realised user-visible problem
  yet — install-time is invisible — but it's pure overhead given that
  `extractNativeLibs="false"` lets the linker work on the same bytes
  in-place.
- **Coupled JS + native asset trees.** Adding/removing a native module
  in the backend requires the runtime overlay still match. Lost
  flexibility vs. shipping addons via standard Android `jniLibs/`
  packaging where the system tooling owns placement.

---

## 2. Target state

```
android/
├── build.gradle               # jniLibs.srcDirs 'libnode/bin/', 'src/main/jniLibs/'
│                              # packagingOptions.jniLibs.useLegacyPackaging = false
├── libnode/                   # unchanged
├── src/main/
│   ├── AndroidManifest.xml    # <application android:extractNativeLibs="false">
│   ├── assets/                # generated; nodejs-project/ only (no nodejs-native/)
│   │   └── nodejs-project/
│   ├── jniLibs/               # generated; one .so per native addon per ABI (gitignored)
│   │   ├── arm64-v8a/
│   │   │   ├── libsodium-native.so
│   │   │   ├── libbetter-sqlite3.so
│   │   │   └── lib<other>.so
│   │   ├── armeabi-v7a/
│   │   └── x86_64/
│   └── java/com/comapeo/core/
│       └── NodeJSService.kt   # only copyAssetFolder(nodejs-project) on cold/upgrade
```

At launch the linker mmaps `lib/<abi>/*.so` straight from the APK
(no extraction — `extractNativeLibs="false"`). The rolled-up bundle's
`__loadAddon('<name>')` does `process.dlopen(mod, 'lib<name>.so')` —
bare filename. Bionic's per-app linker namespace resolves the bare
name against the APK's mmap region for `lib/<abi>/`. Validated end-
to-end in `digidem/nodejs-mobile-bare-prebuilds@feat/jnilibs-xcframework-packaging`'s
test harness.

Key constraint flagged repeatedly in canonical §0.1, §4, §8: a
**full-path** `dlopen('/data/app/.../lib/<abi>/libsodium-native.so')`
**fails** under `extractNativeLibs="false"` even though the file is
present and correct in the APK. `getApplicationInfo().nativeLibraryDir`
returns a real directory containing nothing. Bare name only. If a
load failure surfaces during Phase 2 Android testing, confirm the
JS code is using bare names before chasing ELF or packaging issues.

The asset tree shrinks to JS-only:
`assets/nodejs-project/{index.mjs, package.json, node_modules/...}`
with `node_modules/` containing only the JS-side `package.json` +
`binding.gyp` of each native module (kept by `KEEP_THESE_FROM_BACKEND`).
The runtime asset extraction still mirrors Phase 1's `lastUpdateTime`
gate; size goes from ~few-MB-per-ABI to a small JS-and-migrations tree.

---

## 3. Implementation steps

### Step 1 — `scripts/build-backend.ts`: emit `jniLibs/`

Replace the existing Android prebuild placement (the
`ANDROID_ARCHS.map` block that writes into
`android/src/main/assets/nodejs-native/`) with a `jniLibs/` write:

```ts
const ANDROID_JNILIBS_DIR = join(PROJECT_ROOT, "android/src/main/jniLibs");
rmSync(ANDROID_JNILIBS_DIR, { force: true, recursive: true });

await Promise.all(
  ANDROID_ARCHS.map(async (arch) => {
    const abi = androidAbiForArch(arch); // existing switch: arm→armeabi-v7a, …
    const outDir = join(ANDROID_JNILIBS_DIR, abi);
    mkdirSync(outDir, { recursive: true });

    for (const { name } of NATIVE_MODULES) {
      const srcNode = await findNodeForArch(name, `android-${arch}`);
      // lib<name>.so — bare-name dlopen target. Same convention as
      // `<name>.framework/<name>` on iOS (§2): unversioned, single
      // version-per-module assumption holds today.
      await cp(srcNode, join(outDir, `lib${name}.so`), { force: true });
    }
  }),
);
```

`findNodeForArch` is the same helper introduced for the iOS xcframework
pass; lift it out so it's shared. Drop the
`assets/nodejs-native/` write entirely. Phase 1's prebuild glob into
`TEMP_NODEJS_NATIVE_ASSETS_DIR/node_modules/<name>/prebuilds/android-<arch>/`
stays — it's the input.

### Step 2 — `android/build.gradle`: add jniLibs source set + packaging options

```gradle
android {
  ...
  sourceSets {
    main {
      jniLibs.srcDirs 'libnode/bin/', 'src/main/jniLibs/'
      assets {
        srcDirs 'src/main/assets'
      }
    }
  }
  packagingOptions {
    jniLibs {
      useLegacyPackaging false
    }
    excludes += [
      "**/libc++_shared.so",
      "**/libfbjni.so",
    ]
  }
}
```

`useLegacyPackaging = false` is the AGP knob that pairs with
`extractNativeLibs="false"` — it tells the toolchain to keep `.so`
files uncompressed and aligned in the APK so the linker can mmap
them in place.

### Step 3 — `android/src/main/AndroidManifest.xml`: set `extractNativeLibs`

```xml
<application
    android:extractNativeLibs="false"
    ...>
  ...
</application>
```

The opt-in marker. Without it, AGP defaults to extracting `.so`s to
`nativeLibraryDir` at install time (the legacy behaviour), and bare-name
`dlopen` from inside the bundled Node breaks because the linker
namespace doesn't include the in-APK mmap region.

### Step 4 — `NodeJSService.kt`: drop the `nodejs-native` overlay

In `start()`:

```kotlin
if (shouldCopyAssets()) {
  withContext(Dispatchers.IO) {
    nodeProjectDir.deleteRecursively()
    copyAssetFolder(NODEJS_PROJECT_DIRNAME, nodeProjectDir)
    log("Copied $NODEJS_PROJECT_DIRNAME into data directory")
    // <delete the abiName + nodejs-native/<abi> overlay block>
  }
}
```

The `getCurrentABIName()` JNI export becomes unused inside Kotlin —
remove its callsite, leave the JNI export itself in place if anything
in the C++ JNI host still references it (audit before deletion).

`NODEJS_NATIVE_ASSETS_DIRNAME` constant is unused after this; delete.

### Step 5 — Unified `rollup-plugin-addon-loader.js`

Rename `backend/rollup-plugins/rollup-plugin-ios-addon-loader.js` to
`rollup-plugin-addon-loader.js` and lift the per-platform body into the
runtime helper banner. Plugin signature accepts `{ platform: 'android'
| 'ios' }`; same three replacement patterns as before. Banner becomes:

```js
const __addonCache = new Map();
function __loadAddon(name) {
  const cached = __addonCache.get(name);
  if (cached) return cached;
  const mod = { exports: {} };
  // PLATFORM substitution happens at build time.
  if (process.platform === "android") {
    process.dlopen(mod, "lib" + name + ".so");
  } else {
    const dir = process.env.NATIVE_LIB_DIR;
    process.dlopen(mod, dir + "/" + name + ".framework/" + name);
  }
  __addonCache.set(name, mod.exports);
  return mod.exports;
}
globalThis.__loadAddon = __loadAddon;
```

`process.platform` returns `"android"` on nodejs-mobile Android and
`"ios"` on nodejs-mobile iOS, so a single banner works for both
outputs without per-build substitution. (Cross-checked against the
bundled resolver code path inspected during Phase 2 iOS work —
`process.platform` is the same source the bare resolvers use to pick
prebuild dirs today.)

`rollup-plugin-native-paths.js` is deleted. `backend/rollup.config.js`
applies the unified plugin to both outputs and the same banner string
goes into both `output.banner`. The two outputs continue to differ
only by the maps-plugin alias (still iOS-only).

### Step 6 — `backend/lib/create-comapeo.js`: no change needed

PR #16 already wrote this:

```js
const betterSqlite3NativeBinding =
  globalThis.__loadAddon?.("better-sqlite3");
```

On Android post-Phase-2, `__loadAddon` is defined (the banner runs on
both bundles) and resolves better-sqlite3 the same way the holepunch
modules resolve. No edit required; the optional chain stops being a
no-op on Android.

### Step 7 — Tests

- `Instrumented Tests (30)` (Android emulator): same workflow runs,
  expected to pass without modification. The path differences are
  internal to the loader; the testable surface is unchanged.
- Add a quick `NodeServiceLifecycleAndroidTest`-style coverage if one
  doesn't exist that asserts the equivalent of iOS's
  `CoreManagerSmokeTest` (sees the control socket's `ready` broadcast).
  Optional — the existing JVM unit tests + instrumented tests already
  exercise the full backend via the real CoMapeoCoreService.
- iOS smoke + lifecycle tests should continue passing — the rollup
  config edit is a refactor of the iOS-path-only plumbing into a
  shared plugin.

---

## 4. Risks

1. **Bare-name `dlopen` fails on a misconfigured Android build.** The
   most-load-bearing bug surface in the migration. If the
   `extractNativeLibs="false"` + `useLegacyPackaging=false` pair isn't
   applied or the manifest is overridden by a downstream Expo plugin,
   the linker namespace doesn't see the APK's `lib/<abi>/` segment and
   the first `__loadAddon('sodium-native')` aborts with
   `dlopen failed: library "libsodium-native.so" not found`.
   Diagnose with
   `unzip -l <App>.apk | grep "lib/.*\.so"` (entries should be
   uncompressed) and `aapt dump badging <App>.apk | grep extractNativeLibs`
   (should print `extractNativeLibs:'-1'` after AGP rewrites).

2. **Expo's manifest merger may strip `extractNativeLibs`.** Expo's
   `expo-build-properties` plugin can rewrite the application manifest.
   Verify the post-prebuild manifest at
   `example/android/app/src/main/AndroidManifest.xml` retains the
   attribute, and add `expo-build-properties` config to the example app
   if it doesn't survive.

3. **Cross-arch APK splits.** AGP can produce per-ABI APK splits where
   each split contains only its ABI's `lib/`. Bare-name `dlopen` still
   works because each split's linker namespace covers its own ABI.
   Test the unsplit + split paths if release builds use splits.

4. **16 KB page alignment.** Phase 1 was already constrained to 16 KB
   pages via the `nodejs-mobile-bare-prebuilds`
   `-Wl,-z,max-page-size=16384` flag. Confirm with
   `readelf -l <jniLibs>/<abi>/lib<name>.so | grep LOAD` after build
   on at least one shipped `.so`. If a future addon turns up
   misaligned, AGP will reject the APK on Android 15+ devices.

5. **Removing `getCurrentABIName()` callsite breaks JNI symbol
   linkage.** The `external fun getCurrentABIName(): String` declaration
   in the `companion object` of `NodeJSService.kt` is a JNI function
   declaration — its native counterpart in `cpp/native-lib.cpp` (or
   wherever the JNI host lives) might still be referenced. Drop the
   Kotlin `external fun` declaration AND its caller in the same change;
   leave the C++ symbol alone unless we audit it has no other
   consumers. (Worst case a stranded C++ function is dead code, not a
   load failure.)

6. **`patches/@comapeo+core+7.1.0.patch` already covers Android.** No
   patch update needed — `betterSqlite3NativeBinding` becomes truthy
   on Android once `__loadAddon` is defined, and the patch already
   conditionalises on truthy. Mention this in the PR description so
   reviewers don't expect a patch update.

7. **AGP version + compileSdk gating.** `useLegacyPackaging = false`
   has been the AGP default since 4.2; `extractNativeLibs="false"` is
   accepted on `compileSdk >= 23`. Project's current AGP and compileSdk
   are well past those. No risk in practice; mentioned for completeness.

8. **Loss of `.node` extension.** Some libraries inspect the path of a
   loaded native module (e.g., for stack traces or extension loading).
   Bare-name `dlopen` against `lib<name>.so` returns a path inside the
   APK; modules that trust their path may misbehave. Smoke-test each
   of the seven addons under realistic use, not just `require`-success
   (canonical §8).

---

## 5. Acceptance criteria

- [ ] `npm run backend:build` produces
      `android/src/main/jniLibs/<abi>/lib<name>.so` for each native
      module × each Android ABI.
- [ ] `git ls-files android/src/main/jniLibs/` returns nothing (gitignored).
- [ ] `git ls-files android/src/main/assets/nodejs-native/` returns
      nothing AND the directory is no longer produced.
- [ ] `unzip -l example/android/app/build/outputs/apk/.../app.apk | grep "lib/arm64-v8a"`
      shows `lib<name>.so` entries (i.e. the linker can mmap them in
      place); `aapt dump badging` confirms `extractNativeLibs:'-1'`.
- [ ] `Instrumented Tests (30)` passes on Android emulator API 30
      with the new packaging — confirms bare-name `dlopen` works
      end-to-end.
- [ ] `Integration Tests (Example App)` (iOS) still passes — confirms
      the rollup loader plugin refactor didn't regress iOS.
- [ ] `iOS Device Build (xcframework codesign verification)` still
      passes.
- [ ] `NodeJSService.kt` no longer references `nodejs-native` or
      `getCurrentABIName` from `start()`.
- [ ] `rollup-plugin-native-paths.js` is deleted.
- [ ] `__loadAddon` banner is identical in both bundles
      (`diff <(head -20 android.../index.mjs) <(head -20 ios.../index.mjs)`).

---

## 6. Commit order

Recommend ~5 commits so the diff is reviewable:

1. **`scripts/build-backend.ts`: emit `jniLibs/`, drop
   `assets/nodejs-native/`.** After this, `npm run backend:build`
   produces the new tree but nothing consumes it yet (Android still
   tries to extract from `nodejs-native/` in the running app).
2. **`android/build.gradle` + `AndroidManifest.xml`: jniLibs source
   set, `useLegacyPackaging=false`, `extractNativeLibs="false"`.**
   AGP picks up the new tree on next build but the running app still
   loads from the (now empty) extraction path.
3. **`backend/rollup-plugins/rollup-plugin-addon-loader.js` + delete
   `rollup-plugin-native-paths.js`.** Unified loader rewrite. After
   this, both bundles emit `__loadAddon(name)` with the dispatched
   banner. Verified by `diff` on the head of each bundle.
4. **`NodeJSService.kt`: drop `nodejs-native` overlay + unused
   `getCurrentABIName` callsite.** The behavioural switch — Android
   now expects to find native code via bare-name `dlopen` against the
   APK mmap. After this, `Instrumented Tests` is the canary.
5. **`.gitignore` + plan doc updates.** `android/src/main/jniLibs/`
   added; `android/src/main/assets/nodejs-native/` retained as a guard
   rail; `phase-2-xcframework-plan.md`'s deferred section ticks the
   items this PR landed; canonical `build-architecture-plan.md` Phase
   2 status banner updated.

---

## 7. Defer / out of scope

- **`NodeJSService.kt` JNI stdio pump drain fix.** Same author can
  open immediately after this lands; same area of the JNI host but
  orthogonal to packaging.
- **Real-device runtime smoke test on iOS.** Inherited from
  `phase-2-xcframework-plan.md` §7; no Android angle.
- **Version-stamp gate on `prepareNodeBundle()` (iOS).** Inherited;
  Android's equivalent is already gated via `lastUpdateTime` and stays
  in this branch unchanged.
- **iOS map-tile fetching, `globalThis.fetch` polyfill, maps-stub
  `console.warn`.** Inherited; tracked in
  [`unified-js-bundle-ios-plan.md` §7](./unified-js-bundle-ios-plan.md#7-phase-2-follow-ups).
- **Versioned filenames** (`lib<name>.<version>.so` /
  `<name>@<version>.framework`). Canonical §4.3 covers this; today's
  dep tree is single-version, so the work is mechanical when needed.
- **Static linking** (canonical Appendix B, considered, not chosen).
  No new analysis required.
