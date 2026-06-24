// Example-app-only Expo config plugin. NOT part of the public
// @comapeo/core-react-native API. Consumers of this module never see this
// plugin — it lives under example/plugins/ purely so that the example app
// (which doubles as our integration-test harness) can re-inject its test
// target every time `expo prebuild` regenerates example/ios/.
//
// Mirrors the structure of with-android-tests, which uses the official
// @expo/config-plugins `withAppBuildGradle` + `mergeContents` machinery.
// There is no equivalent first-class mod for the Podfile (Expo deliberately
// does not expose one — the Podfile is Ruby and not safely parsable), so we
// fall back to `withDangerousMod` and use the same `mergeContents` utility
// to inject our target stanza idempotently with a tagged marker comment.
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { withDangerousMod } = require('@expo/config-plugins');
const {
  mergeContents,
} = require('@expo/config-plugins/build/utils/generateCode');

const APP_TARGET_NAME = 'corereactnativeintegration';
const TEST_TARGET_NAME = 'corereactnativeintegrationTests';
const TEST_BUNDLE_ID = 'com.comapeo.core.integration.tests';
const IPHONEOS_DEPLOYMENT_TARGET = '16.4';

// Source of truth for the iOS XCTest sources. Kept under example/tests/ios/
// (rather than bundled with the plugin) to mirror with-android-tests —
// test code for both platforms then lives side-by-side under example/tests/.
const DEFAULT_SOURCE_DIR = '../../tests/ios';

function withIosTestTarget(config, props = {}) {
  const sourceDir = props.sourceDir ?? DEFAULT_SOURCE_DIR;

  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const pluginDir = __dirname;
      const iosDir = path.join(cfg.modRequest.projectRoot, 'ios');

      copyTestSources(pluginDir, sourceDir, iosDir);
      patchPodfile(iosDir);
      runAddTestTargetScript(pluginDir, iosDir);

      return cfg;
    },
  ]);
}

function copyTestSources(pluginDir, sourceDir, iosDir) {
  const srcDir = path.resolve(pluginDir, sourceDir);
  const dstDir = path.join(iosDir, TEST_TARGET_NAME);

  if (!fs.existsSync(srcDir)) {
    throw new Error(`with-ios-tests: source dir not found: ${srcDir}`);
  }

  fs.mkdirSync(dstDir, { recursive: true });
  for (const name of fs.readdirSync(srcDir)) {
    if (!name.endsWith('.swift')) continue;
    fs.copyFileSync(path.join(srcDir, name), path.join(dstDir, name));
  }
}

function patchPodfile(iosDir) {
  const podfilePath = path.join(iosDir, 'Podfile');
  const podfile = fs.readFileSync(podfilePath, 'utf8');

  const targetBlock = `  target '${TEST_TARGET_NAME}' do
    inherit! :search_paths
  end`;

  // mergeContents handles the "already merged" case via the tag marker:
  // `# @generated begin with-ios-tests:test-target ...` / `# @generated end`.
  // Re-running prebuild after the block is in place returns didMerge: false
  // and we skip the write. A missing anchor throws ERR_NO_MATCH from inside
  // mergeContents — let that propagate; the message points at the regex.
  const result = mergeContents({
    tag: 'with-ios-tests:test-target',
    src: podfile,
    newSrc: targetBlock,
    anchor: /^(\s*)post_install do \|installer\|/m,
    offset: 0,
    comment: '#',
  });

  if (result.didMerge) {
    fs.writeFileSync(podfilePath, result.contents);
  }
}

function runAddTestTargetScript(pluginDir, iosDir) {
  const script = path.join(pluginDir, 'add-test-target.rb');
  execFileSync('ruby', [script], {
    cwd: iosDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      APP_TARGET_NAME,
      TEST_TARGET_NAME,
      TEST_BUNDLE_ID,
      IPHONEOS_DEPLOYMENT_TARGET,
    },
  });
}

module.exports = withIosTestTarget;
