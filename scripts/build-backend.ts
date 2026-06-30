import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { $ } from "execa";

import { NATIVE_MODULES, collectNativePairs } from "./lib/native-modules.ts";
import { readNodeJsMobileVersions } from "./lib/node-versions.ts";
import { downloadPrebuilds } from "./lib/prebuilds.ts";
import { packageAndroidJniLibs } from "./lib/android-jni.ts";
import { packageIosFrameworks } from "./lib/ios-frameworks.ts";
import { audit16kAlignment } from "./lib/check-16k-alignment.ts";

// ------------------------------------------------
// Paths
// ------------------------------------------------

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BACKEND_SRC_DIR = join(PROJECT_ROOT, "backend");

// Final destinations consumed by the React Native module's native
// targets. Rolldown writes the bundled JS + static assets directly here
// (see `backend/rolldown.config.ts`); the per-platform packagers below
// fill in the native-binary side.
const ANDROID_DEBUG_NODEJS_PROJECT_DIR = join(
  PROJECT_ROOT,
  "android/src/debug/assets/nodejs-project",
);
const ANDROID_MAIN_NODEJS_PROJECT_DIR = join(
  PROJECT_ROOT,
  "android/src/main/assets/nodejs-project",
);
const ANDROID_JNILIBS_DIR = join(PROJECT_ROOT, "android/src/main/jniLibs");
const ANDROID_LIBNODE_DIR = join(PROJECT_ROOT, "android/libnode/bin");
const IOS_NODEJS_PROJECT_DIR = join(PROJECT_ROOT, "ios/nodejs-project");

// Sourcemap relocation targets — sibling of the per-platform asset/
// resource trees so they ship in the npm tarball but stay out of the
// APK/IPA. The relocate-sourcemaps rolldown plugin moves `*.map` here
// after writeBundle. Consumed by `comapeo-rn-upload-sourcemaps` at
// the consumer's CI step.
//
// The Android *debug* output has no relocation target: its map stays
// colocated with the bundle in `src/debug/assets/nodejs-project/` (shipped
// only in debug variants) so Node can remap stacks in-process. See
// `backend/rolldown.config.ts`.
const ANDROID_MAIN_SOURCEMAPS_DIR = join(
  PROJECT_ROOT,
  "android/src/main/nodejs-sourcemaps",
);
// iOS maps are laid out under a `nodejs-project/` dir so the Debug-only
// `ComapeoCoreSourcemaps` companion pod can ship them as a `nodejs-project`
// resource that merges next to the bundle in the app (see that podspec and
// `app.plugin.js`'s `withDebugSourcemapsIos`).
const IOS_SOURCEMAPS_DIR = join(
  PROJECT_ROOT,
  "ios/nodejs-sourcemaps/nodejs-project",
);
// One xcframework per native module instance. CocoaPods picks them up
// via `vendored_frameworks` in ComapeoCore.podspec; Xcode's standard
// Embed & Sign phase places + codesigns them into <App>.app/Frameworks/
// at app build time. Validated end-to-end by
// digidem/nodejs-mobile-bare-prebuilds@feat/jnilibs-xcframework-packaging.
const IOS_FRAMEWORKS_DIR = join(PROJECT_ROOT, "ios/Frameworks");

// Throwaway scratch dirs. Wiped at the start of each phase that uses
// them, and (for the iOS frameworks workspace) at the end too.
const SCRATCH_DIR = join(PROJECT_ROOT, "nodejs-assets");
const PREBUILDS_DIR = join(SCRATCH_DIR, "native");
const IOS_FRAMEWORKS_WORK_DIR = join(SCRATCH_DIR, "frameworks");

// ------------------------------------------------
// Pipeline
// ------------------------------------------------

rmSync(SCRATCH_DIR, { force: true, recursive: true });

// 1. Native module ABI is read from the libnode header laid down by
//    `npm run download:nodejs-mobile`. Used to pin non-NAPI prebuild
//    URLs (better-sqlite3 today).
const { abi: NODE_ABI } = readNodeJsMobileVersions();

// 2. Enumerate every concrete (name, version) pair of native modules
//    in the dep tree. `npm ci` ran via the `prebackend:build` npm
//    hook, so node_modules is current.
const nativePairs = await collectNativePairs(BACKEND_SRC_DIR, NATIVE_MODULES);

// 3. Rolldown bundles backend/index.js into both per-platform output
//    dirs in one pass. The `OUTPUT_DIR_*` env vars point rolldown at
//    the final native-asset trees, so there's no intermediate
//    staging. Static runtime assets (drizzle SQL, default config,
//    fallback map) are copied alongside the bundle by a plugin in
//    rolldown.config.ts.
await $({
  cwd: BACKEND_SRC_DIR,
  stdio: "inherit",
  env: {
    ...process.env,
    OUTPUT_DIR_ANDROID_DEBUG: ANDROID_DEBUG_NODEJS_PROJECT_DIR,
    OUTPUT_DIR_ANDROID_MAIN: ANDROID_MAIN_NODEJS_PROJECT_DIR,
    OUTPUT_DIR_IOS: IOS_NODEJS_PROJECT_DIR,
    SOURCEMAPS_DIR_ANDROID_MAIN: ANDROID_MAIN_SOURCEMAPS_DIR,
    SOURCEMAPS_DIR_IOS: IOS_SOURCEMAPS_DIR,
  },
})`npm run build`;

// 4. Download every (pair × target) prebuild tarball into a single
//    scratch tree. Per-callsite version-aware `__loadAddon` rewrite
//    in rollup-plugin-addon-loader.js loads the right one per
//    importer at runtime.
await downloadPrebuilds(nativePairs, NODE_ABI, PREBUILDS_DIR);

// 5. Android: pack each (name, version) as
//    `jniLibs/<abi>/lib<name>__<version>.so`. Bundled JS loads it via
//    bare-name `process.dlopen` against the APK mmap region.
await packageAndroidJniLibs({
  pairs: nativePairs,
  prebuildsDir: PREBUILDS_DIR,
  jniLibsDir: ANDROID_JNILIBS_DIR,
});

// 6. Audit 16 KB page alignment on every Android .so we ship.
//    Android 15+ rejects APKs whose native libraries have a PT_LOAD
//    segment with p_align < 0x4000. Both the per-addon prebuilds and
//    libnode are linked with `-Wl,-z,max-page-size=16384`
//    (nodejs-mobile-bare-prebuilds/prebuild/action.yml for addons,
//    digidem/nodejs-mobile fork for libnode pending upstream
//    nodejs-mobile/nodejs-mobile#155). This audit verifies it every
//    build so an upstream regression can't slip a misaligned .so
//    into the APK.
await audit16kAlignment({
  roots: [ANDROID_JNILIBS_DIR, ANDROID_LIBNODE_DIR].filter(existsSync),
  cwd: PROJECT_ROOT,
});

// 7. iOS: wrap each (name, version) as `<name>__<version>.xcframework`
//    (device + lipo'd simulator slices). Embed & Sign at app build
//    time; bundled JS loads it via `process.dlopen` against
//    `<App>.app/Frameworks/<key>.framework/<key>`.
//
//    `xcodebuild`, `lipo`, and `install_name_tool` are macOS-only Xcode
//    command-line tools, so this whole pass is gated on
//    `process.platform`. Linux CI runners (Android workflow) skip it
//    cleanly — they don't consume `ios/Frameworks/`.
if (process.platform !== "darwin") {
  console.log(
    "Skipping iOS xcframework wrapping — requires macOS Xcode toolchain (xcodebuild/lipo/install_name_tool). " +
      `Current platform: ${process.platform}.`,
  );
} else {
  await packageIosFrameworks({
    pairs: nativePairs,
    prebuildsDir: PREBUILDS_DIR,
    frameworksDir: IOS_FRAMEWORKS_DIR,
    workDir: IOS_FRAMEWORKS_WORK_DIR,
  });
}
