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
const TEMP_NODEJS_ASSETS_NODEJS_PROJECT_DIR = join(
  TEMP_NODEJS_ASSETS_DIR,
  "nodejs-project",
);
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

await $$({ cwd: TEMP_NODEJS_ASSETS_BACKEND_DIR })`npm run build`;

const NATIVE_MODULES = [
  { name: "better-sqlite3", usesNapi: false },
  // Native module seems to cause issues so do not need for now: https://github.com/digidem/comapeo-mobile/issues/1096
  // {name: 'crc-native', usesNapi: true},
  { name: "fs-native-extensions", usesNapi: true },
  { name: "quickbit-native", usesNapi: true },
  { name: "simdle-native", usesNapi: true },
  { name: "sodium-native", usesNapi: true },
];

const KEEP_THESE_FROM_BACKEND = [
  "package.json",
  // Packaged backend code
  "dist",
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

for (const name of KEEP_THESE_FROM_BACKEND) {
  const source = join(TEMP_NODEJS_ASSETS_BACKEND_DIR, name);

  const destination =
    // Flatten dist into top-level of nodejs-assets directory
    name === "dist"
      ? TEMP_NODEJS_ASSETS_NODEJS_PROJECT_DIR
      : join(TEMP_NODEJS_ASSETS_NODEJS_PROJECT_DIR, name);

  cpSync(source, destination, { recursive: true });
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
  TEMP_NODEJS_ASSETS_NODEJS_PROJECT_DIR,
  ANDROID_ASSETS_NODEJS_PROJECT_DIR,
  { force: true, recursive: true },
);

// Copy bundled backend into the iOS resources tree as well — same source dir,
// two destinations. This is the unified-bundle deliverable: a single rolled-up
// `index.mjs` (plus KEEP_THESE_FROM_BACKEND) drives both platforms.

rmSync(IOS_NODEJS_PROJECT_DIR, { force: true, recursive: true });

cpSync(TEMP_NODEJS_ASSETS_NODEJS_PROJECT_DIR, IOS_NODEJS_PROJECT_DIR, {
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
    const nodeFiles = await Array.fromAsync(
      glob(`node_modules/**/ios-${arch}/**/*.node`, {
        cwd: TEMP_NODEJS_NATIVE_ASSETS_DIR,
      }),
    );

    for (const entry of nodeFiles) {
      const nativeTargetDir = entry.startsWith("node_modules/better-sqlite3/")
        ? join(
            IOS_NODEJS_NATIVE_DIR,
            arch,
            "node_modules/better-sqlite3/build",
            basename(entry),
          )
        : join(IOS_NODEJS_NATIVE_DIR, arch, entry);

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

  const ghReleaseName =
    // For better-sqlite3, we need to use the release built with bare-make
    name === "better-sqlite3" ? `${version}-bare-make` : version;

  return {
    name: assetName,
    url: `https://github.com/digidem/${name}-nodejs-mobile/releases/download/${ghReleaseName}/${assetName}`,
  };
}
