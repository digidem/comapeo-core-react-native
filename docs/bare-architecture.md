# Bare: Build and Native-Integration Architecture

Reference notes on how the Bare runtime (https://github.com/holepunchto/bare)
is built, packaged, and embedded in Android and iOS apps — including the
React Native bridge. Intended as comparison material against our current
`nodejs-mobile` based stack.

All file references below are relative to the repo root
(`bare-reference-repos/...`) unless otherwise noted. Packages not present in
`node_modules` were pulled via `npm pack` for inspection; those references
use the package name and version.

---

## 1. What Bare is

Bare is a lightweight JavaScript runtime built by Holepunch. Unlike Node.js
it exposes a very small C surface (`bare.h`, `js.h`) over V8 (or
JavaScriptCore) plus libuv. Most of the "standard library" — `fs`, `os`,
`crypto`, `url`, `path`, `pipe` — is implemented as **separate npm packages
with N-API-like addons** (`bare-fs`, `bare-os`, `bare-crypto`, etc.). There
is no monolithic runtime binary; you compose what you need. Mobile
embedders build a static artifact (`bare-kit`) containing Bare plus a
curated set of builtin addons and ship it as a platform framework/AAR.

---

## 2. Architecture at a glance

```
   User JS (app.js) ─┐
                     ▼
                bare-pack ─────────► app.bundle         (ships as asset)
                                         │
                                         │ read at startup
                                         ▼
  ┌───────────────────────────────────────────────────────────────┐
  │                      bare-kit artifact                        │
  │                                                               │
  │   bare + libuv + V8/JSC   ◄── statically linked               │
  │         +                                                     │
  │   builtin addons (bare-fs, bare-crypto, …)  ◄── WHOLE_ARCHIVE │
  │         +                                                     │
  │   worklet.c (thread/loop glue)                                │
  │         +                                                     │
  │   worklet.bundle.h (baked-in bootstrap JS)                    │
  │                                                               │
  │   iOS:     BareKit.xcframework                                │
  │   Android: libbare-kit.so + classes.jar (AAR-style)           │
  └───────────────────────────────────────────────────────────────┘
                                         ▲
                                         │ app-specific addons
                                         │
    node_modules/<addon>  ──► bare-link ─┤
                                         │
                              iOS:     <addon>.xcframework
                              Android: lib<addon>.<version>.so + <addon>.classes.jar

  React Native path adds another layer:
    JS → TurboModule (NativeBareKit) → shared/BareKitModule.cc → bare_worklet_* C API
```

Two independent pipelines converge on the app:

- **Bundle pipeline** (JS): `bare-pack` walks the module graph, produces a
  single `.bundle` blob (asar-like) that the runtime opens at start.
- **Link pipeline** (native): `bare-link` collects addon prebuilds from
  `node_modules` and re-emits them in the platform's preferred shape
  (`.xcframework`, `.so`, `.jar`/`.dex`).

The runtime itself (`bare-kit`) is prebuilt and shipped as an immutable
platform artifact — apps do not rebuild it. Only the bundle and app-level
addons change per app.

---

## 3. The toolchain

### 3.1 `bare-make`

From `bare-make@1.7.2/README.md`: "opinionated build system generator based
on CMake. It generates build files for Ninja using Clang as the compiler
toolchain across all supported systems." Three-stage API mirroring CMake:

```
bare-make generate   # configure (CMake + Ninja + Clang)
bare-make build      # compile
bare-make install    # copy artifacts into `prebuilds/`
bare-make test       # ctest wrapper
```

Flags include `--platform`, `--arch`, `--simulator`, `--environment` (for
e.g. `-musl`), `--debug`, `--sanitize`. It pins Clang and Ninja
(`cmake-runtime`, `cmake-toolchains`, `ninja-runtime` deps). The underlying
project is still plain CMake; `bare-make` only picks the generator and
toolchain.

### 3.2 `bare-pack`

Bundles a JS module graph into a single `.bundle` file.

- Algorithm: `bare-pack@2.0.1/index.js` walks the graph via
  `bare-module-traverse`, reads each module source through a caller-
  provided `readModule(url)` callback, and writes each source into a
  `bare-bundle` container keyed by absolute URL.
- **Output format** (`bare-bundle@1.10.0/README.md`):

  ```
  [#!hashbang]
  <header length><header-JSON><file bytes ...>
  ```

  where the header JSON has `files: { "<url>": { offset, length, mode } }`
  plus `main`, `imports`, `resolutions`, `addons`, `assets`. It is an
  ASAR-like binary container of preserved JS source — **not a compiled or
  minified bundle**. Imports are pre-resolved (statically rewritten to
  absolute specifiers) so the runtime doesn't need to do filesystem-based
  resolution at startup.
- Key CLI flags (`bare-pack@2.0.1/README.md`):
  - `--linked` — resolve `require.addon(...)` calls to `linked:` specifiers
    (required for mobile, since addons are ahead-of-time-linked, not loaded
    from disk).
  - `--builtins <path>` — a JSON file of addon/module names treated as
    provided by the runtime. Those are **excluded from the bundle** and
    resolved at runtime against whatever is statically linked into
    `bare-kit`. This is how `shared/builtins.json` keeps the bundled
    `worklet.bundle.h` small.
  - `--host <platform>-<arch>[-<env>]` — supports multi-host bundles.
  - `--format` — raw `.bundle` or text-wrapped (`.cjs`/`.mjs`/`.json`/`.h`).
  - `--defer <specifier>` — lazy-loaded modules.

### 3.3 `bare-link`

Collects addon prebuilds and produces platform-native packaging.

- `bare-link@3.2.1/index.js` walks `package.json` deps recursively. For
  every package with `"addon": true`, it invokes a per-platform backend.
- **Android backend** (`bare-link/lib/platform/android.js`):
  1. Per host arch (`android-arm64` → `arm64-v8a`, etc.), finds the
     prebuild at `<pkg>/prebuilds/<host>/<name>.bare`.
  2. Parses the ELF with `bare-lief`, **rewrites the SONAME** to
     `lib<name>.<version>.so`, and rewrites DT_NEEDED entries of dependent
     addons to match the same `lib<name>.<version>.so` convention.
  3. Copies any `.dex`/`.jar` siblings into `<out>/<name>.classes.jar`.
  4. Writes the patched `.so` to `<out>/<arch>/lib<name>.<version>.so`.
  - Consequence: Android addons are **dynamic shared libraries** linked at
    runtime via the dynamic linker. The version is encoded into the SONAME
    so multiple major versions can coexist.
- **Apple backend** (`bare-link/lib/platform/apple.js`): groups hosts into
  `macos`/`ios`/`ios-simulator`, builds a `.framework` per OS via
  `createFramework`, then merges them into an XCFramework via
  `createXCFramework` (`xcodebuild -create-xcframework`). Also handles
  code signing (`--sign`, `--identity`, `--keychain`).
- Presets (`bare-link/lib/preset/*.js`) map to host lists:
  - `android`: `android-arm,arm64,ia32,x64`.
  - `ios`: `ios-arm64, ios-arm64-simulator, ios-x64-simulator`.
  - `darwin`, `linux`, `win32`, `mobile` (ios+android), `desktop`.

### 3.4 CMake helpers

These packages bolt addon discovery and linking onto plain CMake.

- **`cmake-fetch`** (`react-native-bare-kit/node_modules/cmake-fetch/`) —
  thin wrapper over `FetchContent` that accepts `github:owner/repo@version`,
  `git:...`, or `https://...zip` specifiers and calls `FetchContent_Declare`
  + `FetchContent_MakeAvailable`. Used to pull the `bare` source (by
  `bare-kit`) and the `bare-kit` prebuilt zip (by `react-native-bare-kit`).

- **`cmake-bare`** (`cmake-bare@1.7.7`) — the heart of addon linking.
  - `download_bare(...)` / `download_bare_headers(...)` install the
    `bare-runtime-<target>` / `bare-headers` npm packages and expose
    includes and the `bare` binary / import library.
  - `add_bare_module(result)` — the "normal" mode: creates **two** targets
    for the current addon's `package.json`:
    1. an OBJECT library `<name>-<version>-<hash>` holding the compiled
       sources,
    2. a SHARED library `<name>-<version>-<hash>_module` built as
       `<name>@<major>.bare` with `-Wl,-undefined,dynamic_lookup` on
       POSIX (i.e. resolves `bare_*` symbols against whatever loads it).
    - Installs the `.bare` into `prebuilds/<host>/<name>.bare`.
  - `link_bare_module(receiver, spec, [SHARED])`:
    - SHARED: links the prebuilt `<name>.bare` as an imported SHARED
      library.
    - Static (default): links the OBJECT library **plus** defines
      `BARE_MODULE_REGISTER_CONSTRUCTOR` and a
      `BARE_MODULE_CONSTRUCTOR_VERSION=<hash>` macro, so the addon's
      init code is pulled in as a global constructor at load time.
  - `link_bare_modules(receiver, [SHARED] [EXCLUDE ...])` — enumerates
    every entry under `node_modules`, reads each `package.json`, and for
    each with `"addon": true` calls `link_bare_module`. This is the
    "auto-discover everything marked as a Bare addon" step.

- **`cmake-bare-bundle`** (`cmake-bare-bundle@3.0.0`) —
  `add_bare_bundle(target ENTRY ... OUT ... BUILTINS ...)` wires an
  `add_custom_command` that runs
  `node <pkg>/dependencies.js` (writes a `.d` depfile) and
  `node <pkg>/bundle.js` (writes the `.bundle` / `.bundle.h` / compiled JS
  header). Internally `bundle.js` calls `bare-pack` with the builtins list
  and writes out a `bundle.h` (C byte-array) via `include-static`, which is
  what gets `#include`d by `worklet.c`.

- **`cmake-napi`** (`cmake-napi@1.2.2`) — mirror of `cmake-bare` for N-API
  addons. Downloads Node.js headers, creates an OBJECT + SHARED `.node`
  pair. On iOS the SHARED step is skipped (`if(host MATCHES "ios") return`)
  because iOS forbids runtime-loaded binaries.

---

## 4. Static vs dynamic linking — what actually happens

This is the point most easily confused across the initial reports. The
source of truth is `bare-kit/overrides.cmake` combined with
`cmake-bare/cmake-bare.cmake`.

**In `bare-kit` itself:**
`bare-kit/overrides.cmake:1-47` **replaces** the default
`add_bare_module` / `add_napi_module` with versions that only create the
OBJECT library and **skip** the SHARED `<name>.bare` target. Combined
with `shared/CMakeLists.txt:136` (`link_bare_modules(bare_worklet
WORKING_DIRECTORY ..)`) this means:

1. For every dep in `bare-kit/node_modules` with `"addon": true`:
2. `link_bare_module` is called in its default (non-SHARED) branch
   (`cmake-bare.cmake:582-598`), which appends both the addon's
   `$<TARGET_OBJECTS:${target}>` **and** the interface requirements of the
   OBJECT library into `bare_worklet`.
3. `BARE_MODULE_REGISTER_CONSTRUCTOR` causes the addon's registration code
   to fire as a global constructor when the final shared lib loads.
4. `bare_worklet` is then wrapped up with
   `$<LINK_LIBRARY:WHOLE_ARCHIVE,bare_static>` (`shared/CMakeLists.txt:131`)
   so that the Bare runtime and JS engine are whole-archive-linked too.

Result: `libbare-kit.so` / `BareKit.framework` is a **single binary that
statically contains Bare, libuv, V8/JSC, the worklet glue, and every
builtin addon listed in `shared/builtins.json`**. There are no separate
`.bare` files beside it.

**In an app that embeds `bare-kit`:**
`bare-link` runs against the app's `node_modules` and produces
`lib<addon>.<version>.so` (Android) or `<addon>.xcframework` (iOS) for
each app-level addon. These are **dynamic**: the addon is dlopen'd by the
Bare module loader when JS `require`s it. The unresolved `bare_*` symbols
they reference are satisfied by `libbare-kit.so` / `BareKit.framework` at
load time (on iOS the `-Wl,-z,global` + `allow-jit` entitlement combo is
what makes this work; see section 9).

So the layering is:

| Layer                         | Linking                         | When |
|-------------------------------|----------------------------------|------|
| Bare runtime + V8/JSC + libuv | Whole-archive static into kit   | Kit build time |
| Builtin addons (`builtins.json`) | Static object + global ctor  | Kit build time |
| `worklet.bundle.h` JS         | Baked C array in kit             | Kit build time |
| App-level addons              | Dynamic `.so`/framework          | App link time (bare-link) |
| App JS (`app.bundle`)         | Streamed from APK / bundled asset | App runtime |

---

## 5. Per-platform packaging

### 5.1 Android

- `bare-kit/android/CMakeLists.txt:1-30` builds `libbare-kit.so` (SHARED)
  which PUBLIC-links `bare_worklet` and PRIVATE-links the NDK `android`
  lib. `-Wl,-z,global` is set so its exported symbols are available to
  subsequently dlopened addons.
- Kit release ships as a zipfile containing `android/bare-kit/` with
  `classes.jar` (the Kotlin/Java wrapper, namespace
  `to.holepunch.bare.kit`, providing `Worklet` and `BaseMessagingService`)
  plus `jni/<abi>/libbare-kit.so` for each of the four ABIs.
- App consumes it via Gradle `sourceSets.main.jniLibs.srcDirs` pointing at
  `libs/bare-kit/jni` plus `src/main/addons` (for addons linked by
  `bare-link`), and `api fileTree("libs", include: "bare-kit/classes.jar")`
  (`bare-android/app/build.gradle:29-33, 76`).
- No CMake, no NDK compile in the app project.

### 5.2 iOS / macOS

- `bare-kit/apple/CMakeLists.txt:1-59` builds a CMake `FRAMEWORK` target
  (`BareKit.framework`) with PUBLIC deps on `Foundation` (and `UIKit`
  under `IOS`). `bare_worklet` is linked PUBLIC.
- `bare-kit/prebuilds/Makefile` creates per-arch frameworks, `lipo`s them
  into fat frameworks per-OS, then `xcodebuild -create-xcframework` merges
  them into `BareKit.xcframework` (lines 10-12, 28-36). JavaScriptCore
  variants are built separately (lines 33-36, 63-72).
- App uses `project.yml` (XcodeGen) to declare
  `framework: app/frameworks/BareKit.xcframework` (`bare-ios/project.yml:27`).

### 5.3 `react-native-bare-kit`

- Does **not** build `bare-kit`. `CMakeLists.txt:6-7` uses
  `cmake-fetch` to download
  `https://github.com/holepunchto/bare-kit/releases/download/v2.0.2/prebuilds.zip`
  and installs `android/bare-kit/` into `android/libs`,
  `ios/BareKit.xcframework` into `ios/`.
- Android: `android/build.gradle:30-33` wires `jniLibs` the same way as
  `bare-android`. CMake *is* invoked here but only to build the
  `BareKitModule.cc` JSI glue into the RN module's own `.so`.
- iOS: podspec `vendored_frameworks = "ios/*.xcframework",
  "ios/addons/*.xcframework"` (`react-native-bare-kit.podspec:29`).
  Xcode handles code signing (embed-and-sign).
- `prepare_command = "node ios/link.mjs"` and the Gradle `link` task
  (`android/build.gradle:50-54`) both run `bare-link` on the consuming RN
  app's `node_modules` so any app-installed Bare addon is surfaced as an
  xcframework or patched `.so` that the kit can dlopen.

---

## 6. Addon developer workflows

There are two different workflows depending on where the addon lives.

### 6.1 Extending the `bare-kit` builtins (rebuilding the kit)

For addons that should be **statically baked** into every shipped kit:

1. Add the addon package to `bare-kit/package.json`'s `dependencies`.
2. Add an entry to `bare-kit/shared/builtins.json` (the runtime side) so
   `bare-pack` treats the module as provided at runtime.
3. `bare-make generate && bare-make build`. `link_bare_modules()` at
   `shared/CMakeLists.txt:136` auto-discovers the new addon via its
   `package.json`'s `"addon": true` flag and links it.
4. Ship new `BareKit.xcframework` / `libbare-kit.so`.

This requires re-releasing `bare-kit`. App authors don't do this; it's a
Holepunch workflow.

### 6.2 App-level addons (dynamic linking via `bare-link`)

This is the normal consumer path:

1. `npm install <addon>` in the app (or RN) project.
2. On build, `bare-link --preset <ios|android>` runs (via a Gradle task
   or an Xcode preAction / Pod `prepare_command`) and walks
   `node_modules`. For each dep with `"addon": true` in its
   `package.json`, it emits the platform package:
   - Android: `android/src/main/addons/<abi>/lib<name>.<version>.so` plus
     optional `<name>.classes.jar`.
   - iOS: `ios/addons/<name>.xcframework`.
3. Gradle/CocoaPods pick up the addon files automatically
   (`sourceSets.jniLibs.srcDirs`, `vendored_frameworks`).
4. `bare-pack --linked` is run against app JS so that
   `require.addon(...)` / `require('<addon>')` in the bundle resolves to
   a `linked:` specifier. At runtime Bare resolves `linked:` by SONAME
   (`lib<name>.<version>.so`) or framework name.

Addon authors must publish prebuilds (`prebuilds/<host>/<name>.bare`) in
their npm package. Those prebuilds are produced by `bare-make` +
`cmake-bare`'s default `add_bare_module` (the SHARED form), typically via
a CI matrix.

---

## 7. JS bundling model

`.bundle` is **not a bundler output in the rollup/webpack sense**. It is
an ASAR-like archive that preserves individual module sources:

- Header is a JSON blob with a map `files[<url>] = { offset, length, mode }`.
- Bodies are concatenated raw file bytes.
- `imports` and `resolutions` pre-record the module graph, so Bare's
  `Module.load()` can resolve `require()` calls without walking
  `node_modules` on disk (critical for sandboxed mobile).
- No transpilation, no tree-shaking, no source-map rewriting.
- Binary asset files and addon specifiers are referenced by URL (`file:`,
  `linked:`, or asset URL).
- Kit's own bootstrap `shared/worklet.js` is itself bundled at kit-build
  time (`shared/CMakeLists.txt:1-7` → `worklet.bundle.h`).

This is a meaningful departure from `nodejs-mobile`, which ships raw JS
files and relies on Node's runtime resolver.

---

## 8. React Native integration

`react-native-bare-kit` exposes the `bare_worklet_*` C API as a
TurboModule.

- Codegen spec: `specs/NativeBareKit.ts` declares `init`, `startFile`,
  `startBytes`, `startUTF8`, `read`, `write`, `update`, `suspend`,
  `resume`, `wakeup`, `terminate`.
- C++ bridge: `shared/BareKitModule.cc` builds `bare_worklet_t`,
  `bare_ipc_t`, `bare_ipc_poll_t`. It defines JSI↔C helpers
  (`jsi_to_buffer`, `jsi_to_string_owned`) and calls the kit's C ABI
  (declared with extern "C" structs).
- JS layer: `index.js`
  - `BareKitIPC` extends `streamx.Duplex`. `_read` calls
    `NativeBareKit.read` and pushes a `Uint8Array`; `_write` batches into
    `NativeBareKit.write`. `_update` tells the native side whether a
    reader/writer is parked; an `on_poll` async callback resumes them.
    The protocol uses `WOULD_BLOCK` return codes for flow control — no
    busy loop, no blocking bridge calls.
  - `BareKitWorklet.start(filename, source, args)` dispatches on source
    type to `startFile` / `startUTF8` / `startBytes` (`index.js:164-227`).
    Pass `null` source to load from disk, pass a string or `Uint8Array`
    to load an in-memory `.bundle`.
  - `AppState.addEventListener('change', BareKitWorklet.update.bind(...))`
    (`index.js:332`) drives the whole suspend/resume lifecycle off RN's
    app state.

`bare-pack` is **not** a dep of `react-native-bare-kit` — consumers are
expected to run it in their own build. The README shows loading a
pre-built bundle via `fs.readFile(...)` and passing the buffer to
`Worklet.start('/app.bundle', source)`.

---

## 9. Notable design choices

- **Whole-archive linking of the runtime** (`bare-kit/shared/CMakeLists.txt:131`)
  ensures symbols like `bare_setup` / `js_create_*` reach addons dlopen'd
  later. Combined with Android's `-Wl,-z,global` (`android/CMakeLists.txt:29`)
  this works without needing an RPATH on the addon.
- **Global constructor addon registration** (`cmake-bare.cmake:584-598`
  + `BARE_MODULE_REGISTER_CONSTRUCTOR`): builtin addons auto-register
  with the Bare module system on library load. No explicit init calls in
  `worklet.c`.
- **Assets streamed from APK** (`bare-android/app/.../MainActivity.kt:22`
  calls `worklet.start("/app.bundle", assets.open("app.bundle"), null)`):
  the bundle is an InputStream on the APK, not extracted to disk. Works
  because `.bundle` is a straight binary archive with length-prefixed
  header. **Unverified:** whether this uses mmap under the hood; the JNI
  wrapper in the closed-source `classes.jar` would need to be decompiled
  to confirm.
- **JIT entitlement on iOS**: `bare-ios/project.yml:25` sets
  `com.apple.security.cs.allow-jit: true`. Required because V8 generates
  code at runtime. `nodejs-mobile` dodges this by using a JIT-less V8
  variant; Bare does not, which means iOS apps must be signed with JIT
  entitlement. JavaScriptCore variants of the kit exist (see the
  `-javascriptcore` suffixes in `prebuilds/Makefile:33-36, 63-72`) as an
  alternative that avoids the entitlement but uses the system JSC.
- **Each addon is an XCFramework** on iOS rather than a loose `.dylib`
  or `.node` file. This lets Xcode's embed-and-sign pipeline handle
  everything uniformly and satisfies App Store rules against shipping
  individual dylibs at arbitrary paths.
- **SONAME rewriting on Android** (`bare-link/lib/platform/android.js:75-96`):
  same addon at different major versions coexist as
  `lib<name>.<majorA>.so` vs `lib<name>.<majorB>.so`. Avoids the
  `nodejs-mobile` style collision on unversioned SO names.
- **Two-phase bundle model** (`bare-android` ships separate `app.bundle`
  and `push.bundle`, each with its own `Worklet` instance) enables
  lightweight push-notification handling without booting the main JS
  context.
- **Assets mechanism for large binaries**: `shared/worklet.js:65-120`
  extracts bundle-embedded asset URLs to a hashed directory next to the
  kit's provided `assets` path, once per bundle id. This lets addons
  that need real filesystem paths (e.g. SQLite, a packaged model file)
  get them without inflating the archive on every run.

---

## 10. Open questions / gaps

- **Closed-source `classes.jar` wrapper** for Android: the kotlin
  `to.holepunch.bare.kit.Worklet` API (including `BaseMessagingService`)
  ships as a prebuilt jar. JNI loading order, threading model inside
  `Worklet.start(InputStream, ...)`, and whether it uses mmap over the
  APK entry are opaque from this side.
- **`--needs libbare-kit.so`** flag in `bare-android/app/build.gradle:42`
  — not documented in `bare-link@3.2.1/README.md`. Likely tells
  `bare-link` to add an extra DT_NEEDED so the ELF loader prioritizes
  resolving `bare_*` symbols against the kit library. **Unverified**
  against newer `bare-link` versions (3.x did not have it when
  `bare-android` was last updated; the repo's package.json pins
  `bare-link@^1.2.0`).
- **Bundle streaming**: `MainActivity.kt` passes `assets.open("app.bundle")`
  (an InputStream) to the native worklet. Whether the native side reads
  it incrementally or slurps to memory is not visible. Also unclear
  whether the APK `.bundle` entry is stored-uncompressed (required for
  mmap) — would need to check the Gradle `aaptOptions` and the released
  APK.
- **Version drift**: the three sample repos pin very different package
  versions:
  - `bare-android`: `bare-link@^1.2.0`, `bare-pack@^1.3.0`
  - `react-native-bare-kit`: consumes `bare-kit@2.0.2` prebuild zip
  - `bare-ios`: unpinned (uses whatever XcodeGen installs)
  Anyone adopting this stack needs to align versions carefully; the link
  and pack output formats have changed between majors (e.g. the
  `--linked` flag and the `BARE_MODULE_CONSTRUCTOR_VERSION` macro are
  recent).
- **NAPI addon path on iOS**: `cmake-napi.cmake:220-224` skips the
  SHARED target entirely on iOS. Whether NAPI addons can be used at all
  on iOS (e.g. via static linking into the kit) is unclear — probably
  only if baked in as builtins.
