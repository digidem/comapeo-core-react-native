const {
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
 * Strategy: drop the bench bundle's single rolled-up file
 * (`index.bench.mjs`) into the consumer's `nodejs-project/` next to
 * the production bundle's own `index.mjs`, and tell the module's
 * loader to run the bench file via the `comapeoEntryFile` /
 * `ComapeoEntryFile` overrides exposed by `@comapeo/core-react-native`.
 * Three mutations:
 *
 *   1. `withGradleProperties` — sets `comapeoEntryFile=index.bench.mjs`
 *      in the consumer app's `android/gradle.properties`.
 *
 *   2. `withInfoPlist` — sets `ComapeoEntryFile=index.bench.mjs` plus
 *      `ComapeoStdoutToOsLog` (opt-in for the nodejs-mobile stdout →
 *      os_log redirect; production leaves this off).
 *
 *   3. `withDangerousMod` (Android) + `withXcodeProject` (iOS) — copies
 *      the rolled-up bench entry from `apps/benchmark/backend/dist/`
 *      into the consumer's `nodejs-project/`:
 *
 *      - Android: drops `index.bench.mjs` into
 *        `<platformProjectRoot>/app/src/main/assets/nodejs-project/`.
 *        AGP's normal asset merge places it alongside the library
 *        module's `index.mjs` in the merged APK.
 *      - iOS: copies `index.bench.mjs` into a source-tree overlay dir
 *        (`<projectName>/nodejs-bench-overlay/`), then adds a Run
 *        Script build phase that `cp`s the file into
 *        `<App>.app/nodejs-project/` after CocoaPods' resource-copy
 *        phase (which is what places the production `nodejs-project/`
 *        from the comapeo-core-react-native pod into the .app).
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

const BENCH_ENTRY_FILE = 'index.bench.mjs';
const BENCH_BUNDLE_SOURCE_DIR = path.resolve(__dirname, '../../backend/dist');

// Subdir inside the iOS prebuild output where we stash the bench
// entry file before Xcode's build phase copies it into the .app.
// Must not collide with the production `nodejs-project/` directory
// CocoaPods materialises in the .app from the comapeo-core-react-native
// pod's `s.resources`.
const IOS_OVERLAY_DIR = 'nodejs-bench-overlay';

const IOS_RUN_SCRIPT_NAME = 'Comapeo bench: copy entry into nodejs-project';

function withComapeoBench(config) {
  config = withBenchGradleProperty(config);
  config = withBenchInfoPlist(config);
  config = withBenchAndroidEntryFile(config);
  config = withBenchIosEntryFile(config);
  return config;
}

function withBenchGradleProperty(config) {
  return withGradleProperties(config, (cfg) => {
    upsertGradleProperty(
      cfg.modResults,
      'comapeoEntryFile',
      BENCH_ENTRY_FILE,
      ' bench entry override — read by android/build.gradle of @comapeo/core-react-native;' +
        '\n# AGP merges the bench file from app/src/main/assets/nodejs-project/ with the library bundle',
    );
    return cfg;
  });
}

function withBenchInfoPlist(config) {
  return withInfoPlist(config, (cfg) => {
    cfg.modResults.ComapeoEntryFile = BENCH_ENTRY_FILE;
    // Opt the bench build into NodeMobileBridge.mm's pipe + dup2 →
    // os_log redirect. Production consumers leave this unset so
    // nodejs-mobile's stdout follows iOS's default routing — keeps
    // the os_log subsystem free of unredacted JS log lines and saves
    // an always-on reader thread.
    cfg.modResults.ComapeoStdoutToOsLog = true;
    return cfg;
  });
}

function withBenchAndroidEntryFile(config) {
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
        'nodejs-project',
      );
      await fsp.mkdir(destDir, { recursive: true });
      await copyBenchEntryFiles(BENCH_BUNDLE_SOURCE_DIR, destDir);
      return cfg;
    },
  ]);
}

function withBenchIosEntryFile(config) {
  // 1. Stash the bench entry file in the source tree so Xcode's Run
  //    Script build phase has something stable to read from.
  config = withDangerousMod(config, [
    'ios',
    async (cfg) => {
      assertBundleExists();
      const overlayDir = path.join(
        cfg.modRequest.platformProjectRoot,
        IOS_OVERLAY_DIR,
      );
      await fsp.mkdir(overlayDir, { recursive: true });
      await copyBenchEntryFiles(BENCH_BUNDLE_SOURCE_DIR, overlayDir);
      return cfg;
    },
  ]);
  // 2. Register a Run Script build phase that copies the bench entry
  //    into the .app's `nodejs-project/` after CocoaPods' resource-copy
  //    phase populates the production bundle there. Idempotent — a
  //    re-prebuild just no-ops if the named phase already exists.
  config = withXcodeProject(config, (cfg) => {
    addOrUpdateBenchScriptPhase(cfg.modResults);
    return cfg;
  });
  return config;
}

async function copyBenchEntryFiles(srcDir, destDir) {
  // Copy `index.bench.mjs` (and its sourcemap, if rollup emitted one).
  // Both filenames are unique within `nodejs-project/` so AGP and the
  // CocoaPods resource copy treat them as additions rather than
  // conflicts with the production bundle.
  const candidates = [BENCH_ENTRY_FILE, `${BENCH_ENTRY_FILE}.map`];
  for (const name of candidates) {
    const src = path.join(srcDir, name);
    if (!fs.existsSync(src)) continue;
    await fsp.cp(src, path.join(destDir, name));
  }
}

/**
 * Adds a `PBXShellScriptBuildPhase` to the first target that copies
 * `<srcroot>/${IOS_OVERLAY_DIR}/${BENCH_ENTRY_FILE}` into
 * `<App>.app/nodejs-project/`. Idempotent: identifies the existing
 * phase by name and updates it in place.
 */
function addOrUpdateBenchScriptPhase(project) {
  const target = project.getFirstTarget();
  if (!target) return;
  const targetUuid = target.uuid;

  const existingUuid = findShellScriptPhaseByName(project, IOS_RUN_SCRIPT_NAME);
  const inputPaths = [
    `$(SRCROOT)/${IOS_OVERLAY_DIR}/${BENCH_ENTRY_FILE}`,
  ];
  const outputPaths = [
    `$(TARGET_BUILD_DIR)/$(UNLOCALIZED_RESOURCES_FOLDER_PATH)/nodejs-project/${BENCH_ENTRY_FILE}`,
  ];
  // `set -euo pipefail` so a missing source or a failed copy fails
  // the build loudly rather than producing a silently-broken .app.
  // `mkdir -p` covers the case where production resource copy hasn't
  // yet created `nodejs-project/` (shouldn't happen given default
  // build-phase order, but cheap insurance).
  const shellScript = [
    'set -euo pipefail',
    'DEST_DIR="${TARGET_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}/nodejs-project"',
    'mkdir -p "$DEST_DIR"',
    `cp "$SCRIPT_INPUT_FILE_0" "$DEST_DIR/${BENCH_ENTRY_FILE}"`,
  ].join('\n');

  if (existingUuid) {
    const phase =
      project.hash.project.objects.PBXShellScriptBuildPhase[existingUuid];
    phase.inputPaths = serializeStringArray(inputPaths);
    phase.outputPaths = serializeStringArray(outputPaths);
    phase.shellPath = '/bin/sh';
    phase.shellScript = JSON.stringify(shellScript);
    return;
  }

  project.addBuildPhase(
    [],
    'PBXShellScriptBuildPhase',
    IOS_RUN_SCRIPT_NAME,
    targetUuid,
    {
      shellPath: '/bin/sh',
      shellScript,
      inputPaths,
      outputPaths,
    },
  );
}

function findShellScriptPhaseByName(project, name) {
  const phases =
    project.hash.project.objects.PBXShellScriptBuildPhase || {};
  for (const uuid of Object.keys(phases)) {
    const phase = phases[uuid];
    // The xcode npm package stores comments under sibling `<uuid>_comment`
    // keys and writes the human-readable name into the phase's `name`
    // field; normalise both.
    if (!phase || typeof phase !== 'object') continue;
    const phaseName = unquote(phase.name);
    if (phaseName === name) return uuid;
  }
  return null;
}

function serializeStringArray(arr) {
  return arr.map((s) => JSON.stringify(s));
}

function unquote(s) {
  if (typeof s !== 'string') return s;
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1);
  }
  return s;
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

function assertBundleExists() {
  const entry = path.join(BENCH_BUNDLE_SOURCE_DIR, BENCH_ENTRY_FILE);
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
