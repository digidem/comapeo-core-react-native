import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { cp, glob, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { $ } from "execa";

const $$ = $({ stdio: "inherit" });

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BACKEND_SRC_DIR = join(PROJECT_ROOT, "backend");
const ANDROID_ASSETS_DIR = join(PROJECT_ROOT, "android/src/main/assets");
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

// TODO: Run postinstall if any patches exist

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

const ANDROID_ARCHS = [
  "arm",
  "arm64",
  // "x64"
] as const;

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
      ANDROID_ARCHS.map(async (arch) => {
        const targetDir = join(prebuildsDir, `android-${arch}`);

        mkdirSync(targetDir, { recursive: true });

        const artifactInfo = getArtifactInfo({
          name,
          version,
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

        // better-sqlite3 includes an additional native module for testing purposes
        // removing since it's not needed and also causes issues with nodejs-mobile-react-native
        if (name === "better-sqlite3") {
          unlinkSync(join(targetDir, "test_extension.node"));
        }
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

// Copy native prebuilds into assets

// TODO: Maybe change location?
const ANDROID_NATIVE_ASSETS_DIR = join(ANDROID_ASSETS_DIR, "nodejs-native");

rmSync(ANDROID_NATIVE_ASSETS_DIR, { force: true, recursive: true });
mkdirSync(ANDROID_NATIVE_ASSETS_DIR, { recursive: true });

await Promise.all(
  ANDROID_ARCHS.map(async (arch) => {
    const androidAbi = arch === "arm" ? "armeabi-v7a" : "arm64-v8a";

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

    // Create dir.list and file.list entries
    {
      const dirListFileEntries = new Set<string>();
      const fileListFileEntries = new Set<string>();

      const nativeAssetsAbiDir = join(ANDROID_NATIVE_ASSETS_DIR, androidAbi);

      const nativeNodeModules = await Array.fromAsync(
        glob("node_modules/**/*", {
          cwd: nativeAssetsAbiDir,
          withFileTypes: true,
        }),
      );

      for (const entry of nativeNodeModules) {
        dirListFileEntries.add(relative(nativeAssetsAbiDir, entry.parentPath));

        if (entry.isFile()) {
          fileListFileEntries.add(
            relative(nativeAssetsAbiDir, join(entry.parentPath, entry.name)),
          );
        }
      }

      await Promise.all([
        writeFile(
          join(nativeAssetsAbiDir, "dir.list"),
          Array.from(dirListFileEntries).join("\n") + "\n",
          "utf-8",
        ),
        writeFile(
          join(nativeAssetsAbiDir, "file.list"),
          Array.from(fileListFileEntries).join("\n") + "\n",
          "utf-8",
        ),
      ]);
    }
  }),
);

// ------------------------------------------------
// Helpers
// ------------------------------------------------

function getNodeJsMobileNodeVersions() {
  const nodeVersionFilePath = new URL(
    "../android/libnode/include/node/node_version.h",
    import.meta.url,
  ).pathname;

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
  arch,
  nodeAbi,
}: {
  name: string;
  version: string;
  arch: string;
  nodeAbi?: string;
}) {
  const assetName = nodeAbi
    ? `${name}-${version}-node-${nodeAbi}-android-${arch}.tar.gz`
    : `${name}-${version}-android-${arch}.tar.gz`;

  return {
    name,
    url: `https://github.com/digidem/${name}-nodejs-mobile/releases/download/${version}/${assetName}`,
  };
}
