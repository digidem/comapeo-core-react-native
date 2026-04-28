import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { cp, glob } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { $ } from "execa";

const $$ = $({ stdio: "inherit" });

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BACKEND_SRC_DIR = join(PROJECT_ROOT, "backend");
const ANDROID_ASSETS_DIR = join(PROJECT_ROOT, "android/src/main/assets");
// iOS Phase 1 ships simulator-only. Device support arrives with the
// xcframework migration in Phase 2. See docs/unified-js-bundle-ios-plan.md.
const IOS_NODEJS_PROJECT_DIR = join(PROJECT_ROOT, "ios/nodejs-project");
const IOS_NODEJS_NATIVE_DIR = join(PROJECT_ROOT, "ios/nodejs-native");
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
// Simulator-only for Phase 1. Device slice (`arm64`) is added in Phase 2 when
// xcframework packaging gives us a single multi-slice artifact per addon.
const IOS_ARCHS = ["arm64-simulator", "x64-simulator"] as const;

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

rmSync(IOS_NODEJS_NATIVE_DIR, { force: true, recursive: true });
mkdirSync(IOS_NODEJS_NATIVE_DIR, { recursive: true });

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

// iOS prebuild placement. Same source tree as Android (`PREBUILD_TARGETS`
// fetched both platforms in one pass above); the layout under
// `ios/nodejs-native/<arch>/` mirrors `android/.../nodejs-native/<abi>/` 1:1
// so the resource extraction code on each platform speaks the same shape.
//
// Phase 2 of the source plan replaces this with `<name>@<version>.xcframework`
// embedded via Xcode's Embed & Sign phase. For Phase 1 the loose `.node`
// files ship inside the `ios/nodejs-native` resource bundle directory and are
// extracted at first launch alongside `nodejs-project/`.
await Promise.all(
  IOS_ARCHS.map(async (arch) => {
    // Drop the `-simulator` suffix from the inner `prebuilds/ios-…` path.
    // The simulator/device split is meaningful for tarball naming, but Bare's
    // addon resolver uses `process.platform` + `process.arch` at runtime —
    // both of which yield e.g. `ios-arm64` regardless of simulator vs device.
    // The outer `<IOS_NODEJS_NATIVE_DIR>/<arch>/` directory still keeps the
    // suffix so the iOS Swift extractor can pick the right slice for the
    // current build.
    const runtimeArch = arch.replace(/-simulator$/, "");

    const nodeFiles = await Array.fromAsync(
      glob(`node_modules/**/ios-${arch}/**/*.node`, {
        cwd: TEMP_NODEJS_NATIVE_ASSETS_DIR,
      }),
    );

    for (const entry of nodeFiles) {
      const runtimeEntry = entry.replaceAll(
        `ios-${arch}`,
        `ios-${runtimeArch}`,
      );
      const nativeTargetDir = entry.startsWith("node_modules/better-sqlite3/")
        ? join(
            IOS_NODEJS_NATIVE_DIR,
            arch,
            "node_modules/better-sqlite3/build",
            basename(entry),
          )
        : join(IOS_NODEJS_NATIVE_DIR, arch, runtimeEntry);

      await cp(join(TEMP_NODEJS_NATIVE_ASSETS_DIR, entry), nativeTargetDir, {
        force: true,
        recursive: true,
      });
    }
  }),
);

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
