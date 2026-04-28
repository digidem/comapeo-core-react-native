import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
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

/**
 * Walk `<TEMP_NODEJS_ASSETS_BACKEND_DIR>/node_modules` for every installed
 * instance of `name` (top-level + every nested copy npm couldn't dedupe),
 * returning each as an `NativeModuleInstance`. Used by both the
 * prebuild-fetch loop and the iOS xcframework wrap loop so multi-version
 * dep trees ship one `<name>__<version>.xcframework` per concrete
 * `(name, version)` pair, not per `name` only — which would silently
 * shadow the lower version with the higher one.
 */
type NativeModuleInstance = {
  name: string;
  version: string;
  /**
   * Absolute path to the package's directory (where `package.json` lives).
   */
  packageDir: string;
  /**
   * True iff this is the hoisted top-level install at
   * `node_modules/<name>/`. Phase-1 Android still uses only the top-level
   * version per name; iOS takes every instance.
   */
  isTopLevel: boolean;
};

function findNativeModuleInstances(name: string): NativeModuleInstance[] {
  const instances: NativeModuleInstance[] = [];
  const seen = new Set<string>();
  const stack: string[] = [join(TEMP_NODEJS_ASSETS_BACKEND_DIR, "node_modules")];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    const candidate = join(dir, name, "package.json");
    if (existsSync(candidate)) {
      const packageDir = dirname(candidate);
      if (!seen.has(packageDir)) {
        seen.add(packageDir);
        const { version } = JSON.parse(readFileSync(candidate, "utf-8"));
        instances.push({
          name,
          version,
          packageDir,
          isTopLevel:
            dir === join(TEMP_NODEJS_ASSETS_BACKEND_DIR, "node_modules"),
        });
      }
    }
    // Descend into nested node_modules dirs anywhere under this one.
    const entries = (() => {
      try {
        return readdirSync(dir, { withFileTypes: true });
      } catch {
        return [];
      }
    })();
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const nested = join(dir, entry.name, "node_modules");
      if (existsSync(nested)) stack.push(nested);
    }
  }
  return instances;
}

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

// Enumerate every concrete (name, version) instance of every native
// module — top-level + every nested copy npm couldn't dedupe.
const NATIVE_INSTANCES = NATIVE_MODULES.flatMap(({ name, usesNapi }) =>
  findNativeModuleInstances(name).map((inst) => ({ ...inst, usesNapi })),
);

// Distinct (name, version) pairs. Multiple disk locations can share the
// same version (e.g. four nested `sodium-native@5.1.0` copies in the
// current dep tree) — they all share one prebuild and, on iOS, one
// xcframework. Per-callsite version-aware `__loadAddon` rewrite in
// backend/rollup-plugins/rollup-plugin-ios-addon-loader.js loads the
// right one per importer; build-side dedup avoids racing four parallel
// fetches into the same temp dir.
const NATIVE_PAIRS = (() => {
  const seen = new Map<string, (typeof NATIVE_INSTANCES)[number]>();
  for (const inst of NATIVE_INSTANCES) {
    const key = `${inst.name}__${inst.version}`;
    if (!seen.has(key)) seen.set(key, inst);
  }
  return [...seen.values()];
})();

const { abi: NODE_ABI } = getNodeJsMobileNodeVersions();

await Promise.all(
  NATIVE_PAIRS.map(async ({ name, version, usesNapi }) => {
    const instanceDir = join(
      TEMP_NODEJS_NATIVE_ASSETS_DIR,
      `${name}__${version}`,
    );

    rmSync(instanceDir, { recursive: true, force: true });

    await Promise.all(
      PREBUILD_TARGETS.map(async ({ platform, arch }) => {
        const targetDir = join(instanceDir, `${platform}-${arch}`);

        mkdirSync(targetDir, { recursive: true });

        const artifactInfo = getArtifactInfo({
          name,
          version,
          platform,
          arch,
          nodeAbi: usesNapi ? undefined : NODE_ABI,
        });

        // `--retry 5 --retry-all-errors --retry-delay 2`: GitHub's
        // releases CDN occasionally serves transient 5xx responses; one
        // 502 was enough to fail an entire CI run on this PR. Retrying
        // up to 5× with a 2 s base delay (curl backs off exponentially)
        // lets the build absorb spurious upstream blips without
        // re-running the workflow. `--retry-all-errors` is what makes
        // 5xx responses retryable — by default curl only retries
        // network-level failures.
        await $({
          cwd: targetDir,
        })`curl --fail --location --retry 5 --retry-all-errors --retry-delay 2 ${artifactInfo.url} --output ${artifactInfo.name}`;

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

// Android prebuild placement: top-level version per name only. Phase 1
// behaviour preserved verbatim — `nodejs-native/<abi>/node_modules/<name>/`
// (no version suffix). The per-callsite multi-version handling that
// iOS gets via xcframework + `__loadAddon(name, version)` doesn't
// exist on Android yet; that lands with the Android jniLibs migration
// (see docs/phase-2-android-jnilibs-plan.md). Until then nested
// versions of a native module collapse to the top-level version's
// .so on Android — historically this has worked by coincidence
// because the addons we depend on have stable NAPI surfaces across
// minor/major bumps.
const TOP_LEVEL_INSTANCES = NATIVE_INSTANCES.filter((i) => i.isTopLevel);

await Promise.all(
  ANDROID_ARCHS.map(async (arch) => {
    const androidAbi = (() => {
      switch (arch) {
        case "arm":
          return "armeabi-v7a";
        case "arm64":
          return "arm64-v8a";
        case "x64":
          return "x86_64";
      }
    })();

    for (const { name, version } of TOP_LEVEL_INSTANCES) {
      const srcArchDir = join(
        TEMP_NODEJS_NATIVE_ASSETS_DIR,
        `${name}__${version}`,
        `android-${arch}`,
      );
      const nodeFiles = await Array.fromAsync(
        glob(`**/*.node`, { cwd: srcArchDir }),
      );

      for (const entry of nodeFiles) {
        // better-sqlite3 expects `node_modules/<name>/build/<binary>.node`
        // (its own loader walks that path); other addons use the
        // standard prebuilds layout the upstream tarball already has.
        const nativeTargetPath =
          name === "better-sqlite3"
            ? join(
                ANDROID_NATIVE_ASSETS_DIR,
                androidAbi,
                "node_modules",
                name,
                "build",
                basename(entry),
              )
            : join(
                ANDROID_NATIVE_ASSETS_DIR,
                androidAbi,
                "node_modules",
                name,
                "prebuilds",
                `android-${arch}`,
                basename(entry),
              );

        await cp(join(srcArchDir, entry), nativeTargetPath, {
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
  NATIVE_PAIRS.map(async ({ name, version }) => {
    // Per-instance directory: `<name>__<version>` so two versions of
    // the same addon (e.g. sodium-native@4.3.3 + @5.1.0 in the
    // current dep tree) each get a distinct xcframework. Underscore-
    // separator instead of `@` because `@` in framework dir names
    // and Mach-O install names is unvalidated territory; double
    // underscore is filesystem-safe and unambiguous.
    const instanceKey = `${name}__${version}`;
    const moduleWorkDir = join(TEMP_FRAMEWORKS_WORK_DIR, instanceKey);
    mkdirSync(moduleWorkDir, { recursive: true });

    /**
     * Build one `<instanceKey>.framework/` directory for the given
     * arch. Returns the absolute path to the framework directory so
     * it can be fed back into `lipo`/`xcodebuild` downstream.
     *
     * `install_name_tool -id` rewrites the Mach-O's `LC_ID_DYLIB`
     * from the upstream prebuild's `<name>.node` (a name dyld cannot
     * resolve inside `<App>.app/Frameworks/`) to
     * `@rpath/<instanceKey>.framework/<instanceKey>`. Without this,
     * `LC_LOAD_DYLIB` self-references in the same binary cause an
     * "image not found" abort at app launch — Embed & Sign + the
     * regular dyld load command walk hits the original install name
     * *before* our runtime `process.dlopen` ever runs. The validated
     * harness (`digidem/nodejs-mobile-bare-prebuilds@feat/jnilibs-xcframework-packaging`)
     * skipped this because its test apps `dlopen` directly without
     * embedding the framework into a fully-linked .app bundle.
     */
    const buildPerArchFramework = async (arch: string, srcNode: string) => {
      const archDir = join(moduleWorkDir, arch);
      const frameworkDir = join(archDir, `${instanceKey}.framework`);
      mkdirSync(frameworkDir, { recursive: true });
      // Mach-O exec name matches the framework dir name so the
      // runtime helper's `process.dlopen('<NATIVE_LIB_DIR>/<instanceKey>.framework/<instanceKey>')`
      // resolves uniformly across addons — even better-sqlite3, whose
      // .node tarball ships as `better_sqlite3.node` (underscore).
      const dstBinary = join(frameworkDir, instanceKey);
      await cp(srcNode, dstBinary);
      await $({
        stdio: "inherit",
      })`install_name_tool -id @rpath/${instanceKey}.framework/${instanceKey} ${dstBinary}`;
      writeFileSync(
        join(frameworkDir, "Info.plist"),
        buildFrameworkPlist(instanceKey),
      );
      return frameworkDir;
    };

    /**
     * Locate the .node file inside the per-instance prebuild tree
     * for the given iOS arch. Bare-style modules ship at
     * `<instanceKey>/<platform>-<arch>/<name>.node`; better-sqlite3
     * ships at `<instanceKey>/<platform>-<arch>/better_sqlite3.node`
     * (underscore). Glob covers both layouts.
     */
    const findNodeForArch = async (arch: string) => {
      const archDir = join(
        TEMP_NODEJS_NATIVE_ASSETS_DIR,
        instanceKey,
        `ios-${arch}`,
      );
      const matches = await Array.fromAsync(
        glob(`**/*.node`, { cwd: archDir }),
      );
      if (matches.length !== 1) {
        throw new Error(
          `Expected exactly one .node file for ${instanceKey} on ios-${arch}; found ${matches.length}: ${matches.join(", ")}`,
        );
      }
      return join(archDir, matches[0]);
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
    const simFatFramework = join(simFatDir, `${instanceKey}.framework`);
    mkdirSync(simFatFramework, { recursive: true });
    writeFileSync(
      join(simFatFramework, "Info.plist"),
      buildFrameworkPlist(instanceKey),
    );
    await $({
      stdio: "inherit",
    })`lipo -create ${join(armSimFramework, instanceKey)} ${join(x64SimFramework, instanceKey)} -output ${join(simFatFramework, instanceKey)}`;

    const xcframeworkPath = join(
      IOS_FRAMEWORKS_DIR,
      `${instanceKey}.xcframework`,
    );
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
  // CFBundleIdentifier accepts only [A-Za-z0-9.-] per Apple's spec —
  // underscores are rejected at app codesign time. Our `instanceKey`
  // form `<name>__<version>` puts a `__` in there, so the bundle ID
  // gets a sanitised variant: `__` collapses to a single `-`. The
  // result is still unique per (name, version) because the version's
  // dots stay (`sodium-native__5.1.0` → `com.digidem.sodium-native-5.1.0`),
  // distinguishing it from any other version of the same addon.
  const bundleId = `com.digidem.${name.replace(/__/g, "-")}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>${name}</string>
  <key>CFBundleIdentifier</key><string>${bundleId}</string>
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
