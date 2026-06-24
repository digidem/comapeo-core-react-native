# Native build & packaging

How the embedded Node.js backend is bundled and how its native addons are
packaged and loaded on each platform. For the
runtime/process side (how native talks to the backend over sockets) see
[`ARCHITECTURE.md`](./ARCHITECTURE.md).

---

## 1. TL;DR

- `scripts/build-backend.ts` (run as `npm run backend:build`) is the whole
  install-time pipeline: it bundles `backend/` and lays down the native addons
  for both platforms.
- Native addons ship as **mmap'd / embedded libraries, not extracted assets**:
  `jniLibs/<abi>/lib<name>__<version>.so` on Android, `<name>__<version>.xcframework`
  on iOS. The `.node` files never touch the device filesystem at runtime.
- Filenames are **versioned** (`name__version`, double-underscore separator) so
  two majors of the same module can coexist — and they do today
  (`better-sqlite3` 11 and 12 ship side by side).
- A rollup plugin rewrites every addon `require(...)` to a generated
  `__loadAddon(name, version)` helper that `process.dlopen`s the right file. No
  runtime monkey-patching; the resolution is baked at build time.
- The set of native modules and their versions is **derived from the backend's
  dependency tree** (`npm ls`), not a hand-maintained version list. `scripts/lib/native-modules.ts`
  only declares *which* deps are native.

---

## 2. The build pipeline (`scripts/build-backend.ts`)

`npm run backend:build` (which `prebackend:build` precedes with
`npm ci --prefix backend`) does four things:

1. **Bundle the backend JS.** Runs the `backend/` build (rolldown, a
   rollup-compatible bundler), emitting a single `index.mjs` + `loader.mjs` and a
   `chunks/` tree, staged into the per-platform locations:
   - Android: `android/src/main/assets/nodejs-project/` (and a `src/debug/`
     variant)
   - iOS: `ios/nodejs-project/`
   Alongside the bundle it copies the runtime assets the bundle can't inline —
   most importantly the drizzle migration `.sql` files, which `@comapeo/core`
   reads from disk at migration time (see
   [build-architecture-plan.md §6](./build-architecture-plan.md)).
2. **Resolve native module versions** (§5). For each module declared native in
   `scripts/lib/native-modules.ts`, enumerate every installed `(name, version)`
   under `backend/node_modules` via `npm ls`.
3. **Package the addons** per platform (§3): download the matching prebuilt
   `.node` from each module's `digidem/<name>-nodejs-mobile` GitHub release, then
   lay it out as a versioned `.so` (Android) or wrap it as a versioned
   `.xcframework` (iOS, darwin only).
4. **Audit 16 KB alignment.** `scripts/lib/check-16k-alignment.ts` parses every
   shipped `.so` and fails the build if any `PT_LOAD` segment isn't aligned to
   `0x4000` — required for Android 15's 16 KB page sizes.

The iOS xcframework-wrapping step (`xcodebuild -create-xcframework`,
`install_name_tool`, `lipo`) is **darwin-gated**: on Linux CI the script builds
the Android artifacts and skips iOS. This is why the npm publish runs on macOS
(see [`release.yml`](../.github/workflows/release.yml)) — publishing from Linux
would ship an empty `ios/Frameworks/`.

---

## 3. Addon packaging — the versioned-filename scheme

Each native addon is laid out per platform with its version baked into the name,
so multiple versions coexist without collision:

**Android** — `android/src/main/jniLibs/<abi>/lib<name>__<version>.so`

```
android/src/main/jniLibs/arm64-v8a/
  libbetter-sqlite3__11.10.0.so
  libbetter-sqlite3__12.9.0.so      # two majors, side by side
  libsodium-native__5.1.0.so
  …
```

`android/build.gradle` adds `src/main/jniLibs/` to `jniLibs.srcDirs` (next to
`libnode/bin/`) and sets `packagingOptions.jniLibs.useLegacyPackaging = false`;
`AndroidManifest.xml` sets `android:extractNativeLibs="false"`. Together these
keep the `.so` files uncompressed and 16 KB-aligned inside the APK's `lib/<abi>/`,
mmap'd at load time rather than extracted.

**iOS** — `ios/Frameworks/<name>__<version>.xcframework`

```
ios/Frameworks/
  better-sqlite3__11.10.0.xcframework
  better-sqlite3__12.9.0.xcframework
  sodium-native__5.1.0.xcframework
  …
```

Each `.node` is wrapped as a Mach-O framework whose internal binary is also named
`<name>__<version>`, with its install name rewritten to
`@rpath/<name>__<version>.framework/<name>__<version>`. `ios/ComapeoCore.podspec`
declares `vendored_frameworks = ['NodeMobile.xcframework', 'Frameworks/*.xcframework']`,
so Xcode's standard **Embed & Sign** phase code-signs them and populates
`<App>.app/Frameworks/` — no custom run-script, no per-`.node` codesign step. The
rolled-up JS ships as a podspec `resource` (`nodejs-project`), read in place from
the app bundle (iOS doesn't extract JS the way Android does).

> The separator is a **double underscore** (`name__version`), not `@` or `.` as
> some earlier drafts of the plan doc show. CFBundleIdentifier sanitises `__` to
> `-` where Apple requires it.

---

## 4. Runtime addon loading

The backend's source calls addons through the usual loader shims
(`require('node-gyp-build')(__dirname)`, `require('bindings')(...)`,
`require.addon(...)`). At bundle time, `backend/rollup-plugins/rollup-plugin-addon-loader.js`
rewrites each of those call sites to a generated helper:

```js
require('node-gyp-build')(__dirname)        →  __loadAddon('sodium-native', '5.1.0')
require('bindings')({ bindings: '…' })      →  __loadAddon('better-sqlite3', '12.9.0')
require.addon('.', __filename)              →  __loadAddon('fs-native-extensions', '1.5.0')
```

The version is resolved **per call site** from the containing package's
`package.json` at transform time, so a multi-version dependency graph gets the
correct file per call site for free. The injected `__loadAddon` helper (a banner
the plugin prepends, platform-substituted) `process.dlopen`s and caches by
`name__version`:

- **Android** — bare filename, no path:
  `process.dlopen(mod, 'lib' + name + '__' + version + '.so')`. With
  `extractNativeLibs="false"` the `.so` is not on disk at any resolvable path; a
  full-path `dlopen` fails. Bionic's per-app linker namespace resolves the bare
  name against the APK's mmap'd `lib/<abi>/` region.
- **iOS** — full path under the embedded frameworks dir:
  `process.dlopen(mod, NATIVE_LIB_DIR + '/' + key + '.framework/' + key)`.
  `ios/AppLifecycleDelegate.swift` exports `NATIVE_LIB_DIR =
  <Bundle.main.bundlePath>/Frameworks` before starting Node, because
  `Frameworks/` isn't on the default dylib search path.

This is the **only** interception mechanism — a build-time rewrite, no runtime
`Module.prototype.require` patch. For the fixed set of seven modules with fully
enumerated loader patterns it's deterministic and surfaces missing prebuilds at
build time. The rationale (and the survey of the alternatives that were dropped)
is in [build-architecture-plan.md Appendix C](./build-architecture-plan.md).

---

## 5. Native modules & the source-of-truth model

The native modules, declared in
[`scripts/lib/native-modules.ts`](../scripts/lib/native-modules.ts) (`NATIVE_MODULES`):

| Module | NAPI? | Prebuild source |
|---|---|---|
| `better-sqlite3` | no | `digidem/better-sqlite3-nodejs-mobile` |
| `crc-native` | yes | `digidem/crc-native-nodejs-mobile` |
| `fs-native-extensions` | yes | `digidem/fs-native-extensions-nodejs-mobile` |
| `quickbit-native` | yes | `digidem/quickbit-native-nodejs-mobile` |
| `rabin-native` | yes | `digidem/rabin-native-nodejs-mobile` |
| `simdle-native` | yes | `digidem/simdle-native-nodejs-mobile` |
| `sodium-native` | yes | `digidem/sodium-native-nodejs-mobile` |

`NATIVE_MODULES` records only *which* deps are native (and whether they use the
NAPI ABI). **Versions are not listed here** — they're resolved from the installed
tree (`npm ls`) at build time, so the source of truth stays
`backend/package.json` + lockfile (via `@comapeo/core` and an `overrides` pin on
`sodium-native`). Bumping a backend dep that pulls a new addon version
automatically fetches the matching prebuild on the next `backend:build`; there's
no manifest line to forget. The plan's proposed `node-native/modules.json` was
not adopted — the in-code constant plus lockfile resolution covers it.

Each addon is prebuilt by its own `digidem/<name>-nodejs-mobile` repo (a thin
wrapper over the reusable `digidem/nodejs-mobile-bare-prebuilds` workflows) and
published as a tagged GitHub release. A required version with no matching release
is a loud build failure, not a silent fallback — ABI match is a correctness
property.

> Divergence from the plan's module list: `udx-native` is no longer used;
> `crc-native` and `quickbit-native` are now present (seven modules, not six).
> `better-sqlite3` on iOS — flagged "not yet working" in the plan — now ships.

---

## 6. Why this shape (in brief)

The load-bearing decisions, condensed; full reasoning in the plan doc:

- **`jniLibs`/`.xcframework` over asset extraction.** No first-launch copy of
  `.node` files to `filesDir`, iOS code-signing is automatic via Embed & Sign,
  and AAB per-ABI splits work. ([plan §3](./build-architecture-plan.md))
- **Versioned filenames over SONAME rewriting.** Filename uniqueness alone lets
  versions coexist; no `patchelf` step. ([plan §0.3, §4.3](./build-architecture-plan.md))
- **Dynamic addons over static-linking into `libnode`.** Once the `.node` files
  are embedded, static linking saves only ~50 ms of boot dlopen for a large
  pipeline cost and worse per-module upgrade granularity.
  ([plan Appendix B](./build-architecture-plan.md))
- **Keep the UDS IPC boundary.** It's the portability insurance for a future
  `nodejs-mobile` → Bare → Hermes/JSI swap. ([plan §2](./build-architecture-plan.md))

---

## 7. Not yet built

Tracked in the plan doc; called out here so a maintainer doesn't assume they
exist:

- **Assembled-backend smoke test** (plan Phase 3). The per-module
  `nodejs-mobile-bare-prebuilds` workflows validate each addon in isolation;
  there is no `scripts/smoke/` harness that loads all seven together inside this
  module's Node bootstrap. Today that coverage comes from the native/integration
  CI suites (see [`TESTING.md`](./TESTING.md)) rather than a dedicated fast smoke.
- **`socket-transport.js` extraction** (plan Phase 4). `node:net` usage is still
  inline in `backend/lib/server-helper.js`; the single-shim extraction that would
  ease a runtime swap hasn't been done. No functional impact today.

---

## 8. References

- [`scripts/build-backend.ts`](../scripts/build-backend.ts) — the pipeline.
- [`scripts/lib/native-modules.ts`](../scripts/lib/native-modules.ts) — the
  native-module declarations + `npm ls` version resolution.
- [`scripts/lib/check-16k-alignment.ts`](../scripts/lib/check-16k-alignment.ts)
  — the alignment audit.
- [`backend/rollup-plugins/rollup-plugin-addon-loader.js`](../backend/rollup-plugins/rollup-plugin-addon-loader.js)
  — the addon `require` rewrite + `__loadAddon` banner.
- `android/build.gradle`, `android/src/main/AndroidManifest.xml`,
  `ios/ComapeoCore.podspec`, `ios/AppLifecycleDelegate.swift` — the packaging /
  embedding config.
- [`build-architecture-plan.md`](./build-architecture-plan.md) — full rationale,
  alternatives, Bare comparison, and migration history.
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — runtime/process model and IPC.
- [`TESTING.md`](./TESTING.md) — how the build is exercised in CI.
