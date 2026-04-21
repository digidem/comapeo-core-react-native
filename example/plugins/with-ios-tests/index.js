const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { withDangerousMod } = require('@expo/config-plugins');

const APP_TARGET_NAME = 'corereactnativeexample';
const TEST_TARGET_NAME = 'corereactnativeexampleTests';
const TEST_BUNDLE_ID = 'com.comapeo.core.example.tests';
const IPHONEOS_DEPLOYMENT_TARGET = '15.1';

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
  let podfile = fs.readFileSync(podfilePath, 'utf8');
  if (podfile.includes(`target '${TEST_TARGET_NAME}'`)) return;

  const subTarget = `
  target '${TEST_TARGET_NAME}' do
    inherit! :search_paths
  end
`;

  const anchor = /^(\s*)post_install do \|installer\|/m;
  if (!anchor.test(podfile)) {
    throw new Error(
      "with-ios-tests: couldn't find `post_install` in Podfile — prebuild template changed?",
    );
  }
  podfile = podfile.replace(anchor, `${subTarget}$&`);
  fs.writeFileSync(podfilePath, podfile);
}

function runAddTestTargetScript(pluginDir, iosDir) {
  const script = path.join(pluginDir, 'add-test-target.rb');
  execSync(`ruby ${JSON.stringify(script)}`, {
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
