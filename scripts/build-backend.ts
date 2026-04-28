import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { cp, glob } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { $ } from "execa";

const $$ = $({ stdio: "inherit" });

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BACKEND_SRC_DIR = join(PROJECT_ROOT, "backend");
const ANDROID_ASSETS_DIR = join(PROJECT_ROOT, "android/src/main/assets");
const IOS_NODEJS_PROJECT_DIR = join(PROJECT_ROOT, "ios/nodejs-project");
// One xcframework per native module. CocoaPods picks them up via
// `vendored_frameworks` in ComapeoCore.podspec; Xcode's standard
// Embed & Sign phase places + codesigns them into <App>.app/Frameworks/
// at app build time. Validated end-to-end by
// digidem/nodejs-mobile-bare-prebuilds@feat/jnilibs-xcframework-packaging.
const IOS_FRAMEWORKS_DIR = join(PROJECT_ROOT, "ios/Frameworks");
const TEMP_NODEJS_ASSETS_DIR = join(PROJECT_ROOT, "nodejs-assets");

const TEMP_NODEJS_ASSETS_BACKEND_DIR = join(TEMP_NODEJS_ASSETS_DIR, "backend");
const TEMP_NODEJS_NATIVE_ASSETS_DIR = join(TEMP_NODEJS_ASSETS_DIR, "native");

rmSync(TEMP_NODEJS_ASSETS_DIR, { force: true, recursive: true });
mkdirSync(TEMP_NODEJS_ASSETS_DIR, { recursive: true });

// ------------------------------------------------
// Bundle the backend
// ------------------------------------------------

cpSync(BACKEND_SRC_DIR, TEMP_NODEJS_ASSETS_BACKEND_DIR, {
  force: true,
  recursive: true,
});

await $$({
  cwd: TEMP_NODEJS_ASSETS_BACKEND_DIR,
})`npm ci --ignore-scripts`;

// `--ignore-scripts` keeps native gyp builds (better-sqlite3) from running,
// but it also skips patch-package's postinstall. Apply patches explicitly
// so backend/patches/*.patch lands on the freshly-installed tree before
// rollup reads it.
await $$({
  cwd: TEMP_NODEJS_ASSETS_BACKEND_DIR,
})`npx patch-package`;

// Rollup writes per-platform bundles to dist/android and dist/ios.
// The iOS bundle has @comapeo/core's maps fastify plugin swapped for a
// no-op stub so undici (which crashes nodejs-mobile iOS at module-init)
// stays out. See backend/rollup.config.js + backend/lib/maps-stub.js.
await $$({ cwd: TEMP_NODEJS_ASSETS_BACKEND_DIR })`npm run build`;

const NATIVE_MODULES = [
  { name: "better-sqlite3", usesNapi: false },
  // Native module seems may cause issues on some devices. If so, exclude from list to use JS version.
  // https://github.com/digidem/comapeo-mobile/issues/1096
  { name: "crc-native", usesNapi: true },
  { name: "fs-native-extensions", usesNapi: true },
  { name: "quickbit-native", usesNapi: true },
  { name: "rabin-native", usesNapi: true },
  { name: "simdle-native", usesNapi: true },
  { name: "sodium-native", usesNapi: true },
];

// Files copied from the backend into every nodejs-project directory.
// Platform-specific bundles (`dist/android`, `dist/ios`) are flattened
// into each per-platform tree below — they don't appear here because they
// differ per target.
const KEEP_THESE_FROM_BACKEND = [
  "package.json",
  // Static folders referenced by @comapeo/core code
  "node_modules/@comapeo/core/drizzle",
  // zip file that is the default config
  "node_modules/@comapeo/default-categories/dist/comapeo-default-categories.comapeocat",
  // Offline fallback map
  "node_modules/@comapeo/fallback-smp",
  // Bare's require.addon() needs the package.json present for native modules
  // At build time we use the presence of binding.gyp to determine whether
  // native addons use node-gyp-build for addon resolution
  ...NATIVE_MODULES.flatMap((m) => {
    const packageJsonPath = join(
      TEMP_NODEJS_ASSETS_BACKEND_DIR,
      "node_modules",
      m.name,
      "package.json",
    );

    const packagePathRelative = relative(
      TEMP_NODEJS_ASSETS_BACKEND_DIR,
      packageJsonPath,
    );

    const bindingGypPath = join(dirname(packagePathRelative), "binding.gyp");
    if (existsSync(join(TEMP_NODEJS_ASSETS_BACKEND_DIR, bindingGypPath))) {
      return [packagePathRelative, bindingGypPath];
    } else {
      return packagePathRelative;
    }
  }),
];

const PLATFORM_NODEJS_PROJECT_DIRS = {
  android: join(TEMP_NODEJS_ASSETS_DIR, "nodejs-project-android"),
  ios: join(TEMP_NODEJS_ASSETS_DIR, "nodejs-project-ios"),
} as const;

for (const platformDir of Object.values(PLATFORM_NODEJS_PROJECT_DIRS)) {
  for (const name of KEEP_THESE_FROM_BACKEND) {
    cpSync(
      join(TEMP_NODEJS_ASSETS_BACKEND_DIR, name),
      join(platformDir, name),
      { recursive: true },
    );
  }
}

// Flatten each platform-specific rollup output (dist/<platform>) into the
// top of its nodejs-project tree. The two bundles share the same input
// graph; only `@comapeo/core/src/fastify-plugins/maps.js` differs (real on
// Android, stub on iOS — see backend/rollup.config.js).
for (const platform of ["android", "ios"] as const) {
  cpSync(
    join(TEMP_NODEJS_ASSETS_BACKEND_DIR, "dist", platform),
    PLATFORM_NODEJS_PROJECT_DIRS[platform],
    { recursive: true },
  );
}

// ------------------------------------------------
// Download prebuilds
// ------------------------------------------------

rmSync(TEMP_NODEJS_NATIVE_ASSETS_DIR, { force: true, recursive: true });

const ANDROID_ARCHS = ["arm", "arm64", "x64"] as const;
// Phase 2: device + both simulator slices. xcframework packaging combines
// them into one multi-slice artifact per addon — Xcode picks the right
// slice at app build time based on the build destination.
const IOS_ARCHS = ["arm64", "arm64-simulator", "x64-simulator"] as const;

/** target = `${platform}-${arch}` (e.g. "android-arm64", "ios-arm64-simulator") */
const PREBUILD_TARGETS = [
  ...ANDROID_ARCHS.map((arch) => ({ platform: "android" as const, arch })),
  ...IOS_ARCHS.map((arch) => ({ platform: "ios" as const, arch })),
];

await Promise.all(
  NATIVE_MODULES.map(async ({ name, usesNapi }) => {
    const packageJsonPath = join(
      TEMP_NODEJS_ASSETS_BACKEND_DIR,
      "node_modules",
      name,
      "package.json",
    );

    const { version } = JSON.parse(readFileSync(packageJsonPath, "utf-8"));

    const { abi: NODE_ABI } = getNodeJsMobileNodeVersions();

    const prebuildsDir = join(
      TEMP_NODEJS_NATIVE_ASSETS_DIR,
      `node_modules/${name}/prebuilds/`,
    );

    rmSync(prebuildsDir, { recursive: true, force: true });

    await Promise.all(
      PREBUILD_TARGETS.map(async ({ platform, arch }) => {
        const targetDir = join(prebuildsDir, `${platform}-${arch}`);

        mkdirSync(targetDir, { recursive: true });

        const artifactInfo = getArtifactInfo({
          name,
          version,
          platform,
          arch,
          nodeAbi: usesNapi ? undefined : NODE_ABI,
        });

        await $({
          cwd: targetDir,
        })`curl --fail --location ${artifactInfo.url} --output ${artifactInfo.name}`;

        await $({
          cwd: targetDir,
        })`tar xzf ${artifactInfo.name} --directory .`;

        unlinkSync(join(targetDir, artifactInfo.name));
      }),
    );
  }),
);

rmSync(TEMP_NODEJS_ASSETS_BACKEND_DIR, { force: true, recursive: true });

// ------------------------------------------------
// Copy files into relevant Android directories
// ------------------------------------------------

rmSync(ANDROID_ASSETS_DIR, { force: true, recursive: true });

// Copy bundled backend into assets

const ANDROID_ASSETS_NODEJS_PROJECT_DIR = join(
  ANDROID_ASSETS_DIR,
  "nodejs-project",
);

cpSync(
  PLATFORM_NODEJS_PROJECT_DIRS.android,
  ANDROID_ASSETS_NODEJS_PROJECT_DIR,
  { force: true, recursive: true },
);

// Copy the iOS-specific rolled-up bundle into the iOS resources tree.
// Diverges from Android only by virtue of the maps-plugin stub baked into
// dist/ios; everything else (KEEP_THESE_FROM_BACKEND, native module
// package.json/binding.gyp) is identical.

rmSync(IOS_NODEJS_PROJECT_DIR, { force: true, recursive: true });

cpSync(PLATFORM_NODEJS_PROJECT_DIRS.ios, IOS_NODEJS_PROJECT_DIR, {
  force: true,
  recursive: true,
});

// Copy native prebuilds into assets

const ANDROID_NATIVE_ASSETS_DIR = join(ANDROID_ASSETS_DIR, "nodejs-native");

rmSync(ANDROID_NATIVE_ASSETS_DIR, { force: true, recursive: true });
mkdirSync(ANDROID_NATIVE_ASSETS_DIR, { recursive: true });

await Promise.all(
  ANDROID_ARCHS.map(async (arch) => {
    let androidAbi: string;
    switch (arch) {
      case "arm": {
        androidAbi = "armeabi-v7a";
        break;
      }
      case "arm64": {
        androidAbi = "arm64-v8a";
        break;
      }
      case "x64": {
        androidAbi = "x86_64";
        break;
      }
      default: {
        throw new Error(`Unsupported arch ${arch}`);
      }
    }

    // Copy native assets from temp folder to relevant Android native assets directory
    {
      const nodeFiles = await Array.fromAsync(
        glob(`node_modules/**/android-${arch}/**/*.node`, {
          cwd: TEMP_NODEJS_NATIVE_ASSETS_DIR,
        }),
      );

      for (const entry of nodeFiles) {
        // better-sqlite3 expects a different directory structure for locating the binding
        const nativeTargetDir = entry.startsWith("node_modules/better-sqlite3/")
          ? join(
              ANDROID_NATIVE_ASSETS_DIR,
              androidAbi,
              "node_modules/better-sqlite3/build",
              basename(entry),
            )
          : join(ANDROID_NATIVE_ASSETS_DIR, androidAbi, entry);

        await cp(join(TEMP_NODEJS_NATIVE_ASSETS_DIR, entry), nativeTargetDir, {
          force: true,
          recursive: true,
        });
      }
    }
  }),
);

// iOS native packaging: wrap each addon's per-arch .node files into a
// single multi-slice xcframework. Recipe lifted from the validated
// harness in digidem/nodejs-mobile-bare-prebuilds@feat/jnilibs-xcframework-packaging
// (`assemble-test-project/action.yml#Wrap addons as xcframeworks`):
//
//   1. For each iOS arch, copy the .node binary as the framework's
//      Mach-O exec inside <work>/<arch>/<name>.framework/<name>, rewrite
//      its install name with `install_name_tool -id @rpath/...`, and
//      write a minimal Info.plist next to it.
//   2. lipo the two simulator binaries into one fat Mach-O so a single
//      simulator slice covers both Apple Silicon and Intel hosts.
//   3. xcodebuild -create-xcframework with the device framework and
//      the lipo'd simulator framework → ios/Frameworks/<name>.xcframework.
//
// `xcodebuild`, `lipo`, and `install_name_tool` are macOS-only Xcode
// command-line tools, so this whole pass is gated on `process.platform`.
// Linux CI runners (Android workflow) skip it cleanly — the Android
// instrumented job doesn't consume `ios/Frameworks/` and would otherwise
// fail at `install_name_tool: spawn ENOENT` before the rollup output it
// actually wants gets copied into Android's resource tree.
if (process.platform !== "darwin") {
  console.log(
    "Skipping iOS xcframework wrapping — requires macOS Xcode toolchain (xcodebuild/lipo/install_name_tool). " +
      `Current platform: ${process.platform}.`,
  );
} else {
  rmSync(IOS_FRAMEWORKS_DIR, { force: true, recursive: true });
  mkdirSync(IOS_FRAMEWORKS_DIR, { recursive: true });

const TEMP_FRAMEWORKS_WORK_DIR = join(TEMP_NODEJS_ASSETS_DIR, "frameworks");
mkdirSync(TEMP_FRAMEWORKS_WORK_DIR, { recursive: true });

await Promise.all(
  NATIVE_MODULES.map(async ({ name }) => {
    // Per-arch frameworks first; assemble into the multi-slice xcframework
    // after lipo'ing the simulator pair.
    const moduleWorkDir = join(TEMP_FRAMEWORKS_WORK_DIR, name);
    mkdirSync(moduleWorkDir, { recursive: true });

    /**
     * Build one `<name>.framework/` directory for the given arch.
     * Returns the absolute path to the framework directory so it can be
     * fed back into `lipo`/`xcodebuild` downstream.
     *
     * `install_name_tool -id` rewrites the Mach-O's `LC_ID_DYLIB` from
     * the upstream prebuild's `<name>.node` (a name dyld cannot resolve
     * inside `<App>.app/Frameworks/`) to
     * `@rpath/<name>.framework/<name>`. Without this, `LC_LOAD_DYLIB`
     * self-references in the same binary cause an "image not found"
     * abort at app launch — Embed & Sign + the regular dyld load
     * command walk hits the original install name *before* our
     * runtime `process.dlopen` ever runs. The validated harness
     * (`digidem/nodejs-mobile-bare-prebuilds@feat/jnilibs-xcframework-packaging`)
     * skipped this because its test apps `dlopen` directly without
     * embedding the framework into a fully-linked .app bundle.
     */
    const buildPerArchFramework = async (arch: string, srcNode: string) => {
      const archDir = join(moduleWorkDir, arch);
      const frameworkDir = join(archDir, `${name}.framework`);
      mkdirSync(frameworkDir, { recursive: true });
      // Mach-O exec name = npm package name. Lets the runtime helper
      // `process.dlopen('<NATIVE_LIB_DIR>/<name>.framework/<name>')`
      // work uniformly across modules — even better-sqlite3, whose
      // .node tarball ships as `better_sqlite3.node` (underscore).
      const dstBinary = join(frameworkDir, name);
      await cp(srcNode, dstBinary);
      await $({
        stdio: "inherit",
      })`install_name_tool -id @rpath/${name}.framework/${name} ${dstBinary}`;
      writeFileSync(join(frameworkDir, "Info.plist"), buildFrameworkPlist(name));
      return frameworkDir;
    };

    /**
     * Locate the .node file inside the prebuilds tree for the given
     * iOS arch. Bare-style modules ship at
     * `prebuilds/ios-<arch>/<name>.node`; better-sqlite3 ships under
     * `build/better_sqlite3.node` (no `prebuilds/`, underscore name).
     * Glob covers both layouts.
     */
    const findNodeForArch = async (arch: string) => {
      const matches = await Array.fromAsync(
        glob(`node_modules/${name}/**/ios-${arch}/**/*.node`, {
          cwd: TEMP_NODEJS_NATIVE_ASSETS_DIR,
        }),
      );
      if (matches.length !== 1) {
        throw new Error(
          `Expected exactly one .node file for ${name} on ios-${arch}; found ${matches.length}: ${matches.join(", ")}`,
        );
      }
      return join(TEMP_NODEJS_NATIVE_ASSETS_DIR, matches[0]);
    };

    const [deviceNode, armSimNode, x64SimNode] = await Promise.all([
      findNodeForArch("arm64"),
      findNodeForArch("arm64-simulator"),
      findNodeForArch("x64-simulator"),
    ]);

    const deviceFramework = await buildPerArchFramework("arm64", deviceNode);

    // Per-arch simulator frameworks live alongside the device one for
    // debuggability; we then lipo their binaries into the fat sim slice.
    const armSimFramework = await buildPerArchFramework(
      "arm64-simulator",
      armSimNode,
    );
    const x64SimFramework = await buildPerArchFramework(
      "x64-simulator",
      x64SimNode,
    );

    const simFatDir = join(moduleWorkDir, "simulator");
    const simFatFramework = join(simFatDir, `${name}.framework`);
    mkdirSync(simFatFramework, { recursive: true });
    writeFileSync(
      join(simFatFramework, "Info.plist"),
      buildFrameworkPlist(name),
    );
    await $({
      stdio: "inherit",
    })`lipo -create ${join(armSimFramework, name)} ${join(x64SimFramework, name)} -output ${join(simFatFramework, name)}`;

    const xcframeworkPath = join(IOS_FRAMEWORKS_DIR, `${name}.xcframework`);
    await $$`xcodebuild -create-xcframework -framework ${deviceFramework} -framework ${simFatFramework} -output ${xcframeworkPath}`;
  }),
);

  rmSync(TEMP_FRAMEWORKS_WORK_DIR, { force: true, recursive: true });
}

// ------------------------------------------------
// Helpers
// ------------------------------------------------

function getNodeJsMobileNodeVersions() {
  const nodeVersionFilePath = fileURLToPath(
    new URL("../android/libnode/include/node/node_version.h", import.meta.url),
  );

  const content = readFileSync(nodeVersionFilePath, "utf-8");

  const major = content.match(/#define NODE_MAJOR_VERSION (.+)/)?.[1];
  const minor = content.match(/#define NODE_MINOR_VERSION (.+)/)?.[1];
  const patch = content.match(/#define NODE_PATCH_VERSION (.+)/)?.[1];
  const abi = content.match(/#define NODE_MODULE_VERSION (.+)/)?.[1];

  return { major, minor, patch, abi };
}

/**
 * Minimal Info.plist for a synthetic iOS framework wrapping a single
 * `.node` Mach-O. Mirrors the harness recipe verbatim — Apple's loader
 * + codesign require these specific keys; trimming further breaks
 * Embed & Sign at app build time.
 */
function buildFrameworkPlist(name: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>${name}</string>
  <key>CFBundleIdentifier</key><string>com.digidem.${name}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>${name}</string>
  <key>CFBundlePackageType</key><string>FMWK</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleSignature</key><string>????</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>MinimumOSVersion</key><string>15.1</string>
</dict></plist>
`;
}

function getArtifactInfo({
  name,
  version,
  platform,
  arch,
  nodeAbi,
}: {
  name: string;
  version: string;
  platform: "android" | "ios";
  arch: string;
  nodeAbi?: string;
}) {
  const assetName = nodeAbi
    ? `${name}-${version}-node-${nodeAbi}-${platform}-${arch}.tar.gz`
    : `${name}-${version}-${platform}-${arch}.tar.gz`;

  return {
    name: assetName,
    url: `https://github.com/digidem/${name}-nodejs-mobile/releases/download/${version}/${assetName}`,
  };
}
