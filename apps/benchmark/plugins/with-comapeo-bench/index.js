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
 * `expo prebuild`. Single source of truth for the bench app's native
 * wiring (it doesn't check in `android/` or `ios/`); production
 * consumers never apply this plugin.
 *
 * - Sets `comapeoEntryFile` / `ComapeoEntryFile = index.bench.mjs` so
 *   the module's loader runs the bench entry from `nodejs-project/`.
 * - Sets `ComapeoStdoutToOsLog = true` for the iOS nodejs-mobile
 *   stdout → os_log redirect (production leaves it off).
 * - Drops `index.bench.mjs` into the consumer's `nodejs-project/`:
 *   Android via AGP asset merge; iOS via a Run Script build phase
 *   that runs after CocoaPods' resource-copy phase.
 *
 * The bench bundle build is NOT triggered here — the bench app's
 * `prebuild` npm script runs rollup first. We fail fast if missing.
 */

const BENCH_ENTRY_FILE = 'index.bench.mjs';
const BENCH_BUNDLE_SOURCE_DIR = path.resolve(__dirname, '../../backend/dist');

// Source-tree subdir for the iOS overlay file. Must not collide with
// the production `nodejs-project/` CocoaPods materialises in the .app.
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
    // See NodeMobileBridge.mm for the rationale on why this is opt-in.
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
  config = withXcodeProject(config, (cfg) => {
    addOrUpdateBenchScriptPhase(cfg.modResults);
    return cfg;
  });
  return config;
}

async function copyBenchEntryFiles(srcDir, destDir) {
  const candidates = [BENCH_ENTRY_FILE, `${BENCH_ENTRY_FILE}.map`];
  for (const name of candidates) {
    const src = path.join(srcDir, name);
    if (!fs.existsSync(src)) continue;
    await fsp.cp(src, path.join(destDir, name));
  }
}

/**
 * Adds (or updates by name — idempotent across reruns) a
 * `PBXShellScriptBuildPhase` that copies the bench entry from the
 * source tree into the .app's `nodejs-project/` at build time.
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
  // `mkdir -p` insures against the default phase-order assumption.
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
