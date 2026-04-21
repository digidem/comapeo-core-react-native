const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { withDangerousMod } = require('@expo/config-plugins');

const APP_TARGET_NAME = 'corereactnativeexample';
const TEST_TARGET_NAME = 'corereactnativeexampleTests';
const TEST_BUNDLE_ID = 'com.comapeo.core.example.tests';
const IPHONEOS_DEPLOYMENT_TARGET = '15.1';

function withIosTestTarget(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const pluginDir = __dirname;
      const iosDir = path.join(cfg.modRequest.projectRoot, 'ios');

      copyTestSources(pluginDir, iosDir);
      patchPodfile(iosDir);
      runAddTestTargetScript(pluginDir, iosDir);

      return cfg;
    },
  ]);
}

function copyTestSources(pluginDir, iosDir) {
  const srcDir = path.join(pluginDir, 'tests');
  const dstDir = path.join(iosDir, TEST_TARGET_NAME);
  fs.mkdirSync(dstDir, { recursive: true });
  for (const name of fs.readdirSync(srcDir)) {
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
