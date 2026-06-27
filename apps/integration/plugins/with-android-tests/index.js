const path = require('path');
const fs = require('fs');
const {
  withAppBuildGradle,
  withDangerousMod,
} = require('@expo/config-plugins');
const {
  mergeContents,
} = require('@expo/config-plugins/build/utils/generateCode');

const DEFAULT_SOURCE_DIR = '../../tests/android';
const DEFAULT_TARGET_PACKAGE = 'com.comapeo.core.integration';

// androidTest deps — kept in sync with what the existing Kotlin tests import.
const ANDROID_TEST_DEPS = [
  "    androidTestImplementation 'androidx.test:runner:1.6.2'",
  "    androidTestImplementation 'androidx.test:rules:1.6.1'",
  "    androidTestImplementation 'androidx.test.ext:junit:1.2.1'",
  "    androidTestImplementation 'androidx.test.uiautomator:uiautomator:2.3.0'",
  "    androidTestImplementation 'org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0'",
].join('\n');

const TEST_RUNNER_LINE =
  '        testInstrumentationRunner "androidx.test.runner.AndroidJUnitRunner"';

function withAndroidTests(config, props = {}) {
  const sourceDir = props.sourceDir ?? DEFAULT_SOURCE_DIR;
  const targetPackage = props.targetPackage ?? DEFAULT_TARGET_PACKAGE;

  config = withAndroidTestSources(config, { sourceDir, targetPackage });
  config = withAndroidTestGradleConfig(config);
  return config;
}

function withAndroidTestSources(config, { sourceDir, targetPackage }) {
  return withDangerousMod(config, [
    'android',
    async (cfg) => {
      const pluginDir = __dirname;
      const srcDir = path.resolve(pluginDir, sourceDir);
      const androidDir = path.join(cfg.modRequest.projectRoot, 'android');
      const packagePath = targetPackage.replace(/\./g, '/');
      const dstDir = path.join(
        androidDir,
        'app',
        'src',
        'androidTest',
        'java',
        packagePath,
      );

      if (!fs.existsSync(srcDir)) {
        throw new Error(
          `with-android-tests: source dir not found: ${srcDir}`,
        );
      }

      fs.mkdirSync(dstDir, { recursive: true });
      for (const name of fs.readdirSync(srcDir)) {
        if (!name.endsWith('.kt')) continue;
        fs.copyFileSync(path.join(srcDir, name), path.join(dstDir, name));
      }
      return cfg;
    },
  ]);
}

function withAndroidTestGradleConfig(config) {
  return withAppBuildGradle(config, (cfg) => {
    let contents = cfg.modResults.contents;

    // The Expo SDK 53 prebuild template already emits the instrumentation
    // runner — only inject if a future template drops it.
    if (!contents.includes('testInstrumentationRunner')) {
      const { contents: next } = mergeContents({
        tag: 'with-android-tests:runner',
        src: contents,
        newSrc: TEST_RUNNER_LINE,
        anchor: /defaultConfig\s*\{/,
        offset: 1,
        comment: '//',
      });
      contents = next;
    }

    const { contents: withDeps } = mergeContents({
      tag: 'with-android-tests:deps',
      src: contents,
      newSrc: ANDROID_TEST_DEPS,
      anchor: /^dependencies\s*\{/m,
      offset: 1,
      comment: '//',
    });

    cfg.modResults.contents = withDeps;
    return cfg;
  });
}

module.exports = withAndroidTests;
