const {
  IOSConfig,
  withDangerousMod,
  withGradleProperties,
  withInfoPlist,
  withXcodeProject,
} = require('@expo/config-plugins');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

/**
 * Wires the bench backend bundle into the consumer Expo app on every
 * `expo prebuild`. The bench app (`apps/benchmark/`) does not check in
 * `android/` or `ios/`, so this plugin is the single source of truth
 * for the native wiring; production consumers (`apps/example/`, third
 * parties) never apply it.
 *
 * Conceptually a stripped-down `expo-asset` plugin: copy a directory
 * tree into the prebuild output's native asset/resource locations and
 * point the module's loader at it via the override hook the module
 * exposes. Three mutations:
 *
 *   1. `withGradleProperties` — sets `comapeoBackendDir=nodejs-bench`
 *      in the consumer app's `android/gradle.properties`. The module's
 *      `android/build.gradle` reads this into
 *      `BuildConfig.COMAPEO_BACKEND_DIR`; the Kotlin loader uses it
 *      as the assets-subdir name when copying the bundle into
 *      `filesDir/` on first launch.
 *
 *   2. `withInfoPlist` — sets `ComapeoBackendDir=nodejs-bench` on the
 *      consumer app's `Info.plist`. The module's `AppLifecycleDelegate`
 *      reads this in `resolveJSEntryPoint` to pick the bundle path
 *      inside the `.app`.
 *
 *   3. `withDangerousMod` (Android + iOS) — copies the rolled-up bench
 *      bundle from `apps/benchmark/backend/dist/` into:
 *        Android: `<platformProjectRoot>/app/src/main/assets/nodejs-bench/`
 *        iOS:     `<platformProjectRoot>/<projectName>/nodejs-bench/`
 *      Plus `withXcodeProject` registers the iOS dir as a blue-folder
 *      reference (`lastKnownFileType=folder`) under the project's
 *      Resources group so Xcode preserves the directory structure when
 *      copying it into the `.app` bundle.
 *
 * The bench bundle build is NOT triggered here — the bench app's
 * `package.json` `prebuild` script runs `npm run --prefix backend
 * build` before `expo prebuild`. Running rollup from inside a config
 * plugin would surprise developers who invoke `expo prebuild` directly,
 * so we fail fast with a helpful error if the bundle is missing.
 *
 * Plugin name retained from the prior bench-toggle implementation
 * (`with-comapeo-bench`) so existing `app.json` references continue
 * to work.
 */
const BENCH_BUNDLE_DIR_NAME = 'nodejs-bench';
const BENCH_BUNDLE_SOURCE_DIR = path.resolve(
  __dirname,
  '../../backend/dist',
);
const BENCH_BUNDLE_ENTRY = 'index.mjs';

function withComapeoBench(config) {
  config = withBenchGradleProperty(config);
  config = withBenchInfoPlist(config);
  config = withBenchAndroidAssets(config);
  config = withBenchIosResources(config);
  return config;
}

function withBenchGradleProperty(config) {
  return withGradleProperties(config, (cfg) => {
    upsertGradleProperty(
      cfg.modResults,
      'comapeoBackendDir',
      BENCH_BUNDLE_DIR_NAME,
      ' bench bundle override — read by android/build.gradle of @comapeo/core-react-native',
    );
    upsertGradleProperty(
      cfg.modResults,
      'comapeoStubRootKey',
      'true',
      ' bench-only opt-out of keystore-backed rootkey; required on devices without' +
        '\n# a configured screen lock (e.g. BrowserStack stock fleet) where the Android' +
        '\n# Keystore super-encryption layer fails on `setUnlockedDeviceRequired(true)`',
    );
    return cfg;
  });
}

function withBenchInfoPlist(config) {
  return withInfoPlist(config, (cfg) => {
    cfg.modResults.ComapeoBackendDir = BENCH_BUNDLE_DIR_NAME;
    // Boolean Info.plist key — see AppLifecycleDelegate.swift's
    // rootKeyProvider closure for the runtime branch and the parallel
    // Android `comapeoStubRootKey` property set above.
    cfg.modResults.ComapeoStubRootKey = true;
    return cfg;
  });
}

function withBenchAndroidAssets(config) {
  return withDangerousMod(config, [
    'android',
    async (cfg) => {
      assertBundleExists();
      const destDir = path.join(
        cfg.modRequest.platformProjectRoot,
        'app',
        'src',
        'main',
        'assets',
        BENCH_BUNDLE_DIR_NAME,
      );
      await replaceDirectory(BENCH_BUNDLE_SOURCE_DIR, destDir);
      return cfg;
    },
  ]);
}

function withBenchIosResources(config) {
  // 1. Copy the bundle into the Xcode project source root so it sits
  //    next to the app's other in-tree resources.
  config = withDangerousMod(config, [
    'ios',
    async (cfg) => {
      assertBundleExists();
      const projectName = IOSConfig.XcodeUtils.getProjectName(
        cfg.modRequest.projectRoot,
      );
      const destDir = path.join(
        cfg.modRequest.platformProjectRoot,
        projectName,
        BENCH_BUNDLE_DIR_NAME,
      );
      await replaceDirectory(BENCH_BUNDLE_SOURCE_DIR, destDir);
      return cfg;
    },
  ]);
  // 2. Register the directory as a folder reference (blue folder) on
  //    the app target. `lastKnownFileType=folder` is the standard
  //    Xcode encoding for "preserve directory structure when copying
  //    to the .app" — what we need so nodejs-mobile finds
  //    `<App>.app/nodejs-bench/index.mjs` at runtime.
  config = withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const projectName = IOSConfig.XcodeUtils.getProjectName(
      cfg.modRequest.projectRoot,
    );
    const relPath = path.join(projectName, BENCH_BUNDLE_DIR_NAME);
    // Idempotency: re-running prebuild shouldn't accumulate duplicate
    // file refs. `pbxProject.hasFile` checks by `file.path`.
    if (project.hasFile && project.hasFile(relPath)) {
      return cfg;
    }
    // `pbxProject.addResourceFile` unconditionally calls
    // `correctForResourcesPath` which crashes if the project has no
    // 'Resources' PBXGroup yet. Default Expo prebuild output has no
    // such group, so create it first — `addToResourcesPbxGroup` later
    // attaches the file ref under it.
    IOSConfig.XcodeUtils.ensureGroupRecursively(project, 'Resources');
    project.addResourceFile(relPath, { lastKnownFileType: 'folder' });
    return cfg;
  });
  return config;
}

function upsertGradleProperty(props, key, value, comment) {
  const existing = props.find(
    (p) => p.type === 'property' && p.key === key,
  );
  if (existing) {
    existing.value = value;
    return;
  }
  if (comment) {
    props.push({ type: 'comment', value: comment });
  }
  props.push({ type: 'property', key, value });
}

async function replaceDirectory(srcDir, destDir) {
  await fsp.rm(destDir, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(destDir), { recursive: true });
  await fsp.cp(srcDir, destDir, { recursive: true });
}

function assertBundleExists() {
  const entry = path.join(BENCH_BUNDLE_SOURCE_DIR, BENCH_BUNDLE_ENTRY);
  if (!fs.existsSync(entry)) {
    throw new Error(
      `with-comapeo-bench: bench bundle not found at ${entry}.\n` +
        `Run \`npm install --prefix backend && npm run build --prefix backend\` ` +
        `from apps/benchmark/ (or \`npm run prebuild\` which does both) ` +
        `before \`expo prebuild\`.`,
    );
  }
}

module.exports = withComapeoBench;
