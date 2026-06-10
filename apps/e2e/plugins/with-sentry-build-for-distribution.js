// E2e-app-only Expo config plugin. NOT part of the public
// @comapeo/core-react-native API.
//
// Workaround for sentry-cocoa issue #7950: under Xcode 26's Swift 6 toolchain,
// `@_implementationOnly import _SentryPrivate` in SentrySDK.swift prevents the
// Swift module interface from exporting `startTransaction` methods when a pod is
// built without BUILD_LIBRARY_FOR_DISTRIBUTION = YES.  The symptom is a compile
// error "type 'SentrySDK' has no member 'startTransaction'" in any Swift file
// that calls that API (SentryNativeBridge.swift in our case).
//
// The fix is to set BUILD_LIBRARY_FOR_DISTRIBUTION = YES on all Sentry pod
// targets so that the Swift compiler generates a stable .swiftinterface text
// file that properly exports all public methods.  We do this via a CocoaPods
// post_install hook injected idempotently into the generated Podfile.
//
// References:
//   https://github.com/getsentry/sentry-cocoa/issues/7950
const path = require('path');
const fs = require('fs');
const { withDangerousMod } = require('@expo/config-plugins');
const {
  mergeContents,
} = require('@expo/config-plugins/build/utils/generateCode');

const HOOK = `\
post_install do |installer|
  installer.pods_project.targets.each do |target|
    next unless target.name.start_with?('Sentry')

    target.build_configurations.each do |config|
      config.build_settings['BUILD_LIBRARY_FOR_DISTRIBUTION'] = 'YES'
    end
  end
end`;

function withSentryBuildForDistribution(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const iosDir = path.join(cfg.modRequest.projectRoot, 'ios');
      patchPodfile(iosDir);
      return cfg;
    },
  ]);
}

function patchPodfile(iosDir) {
  const podfilePath = path.join(iosDir, 'Podfile');
  const podfile = fs.readFileSync(podfilePath, 'utf8');

  // Insert our hook *before* the existing post_install block so that React
  // Native's own post_install (react_native_post_install, etc.) still runs
  // afterwards.  mergeContents uses the tagged marker comments to make the
  // injection idempotent across repeated `expo prebuild` runs.
  const result = mergeContents({
    tag: 'with-sentry-build-for-distribution',
    src: podfile,
    newSrc: HOOK,
    anchor: /^(\s*)post_install do \|installer\|/m,
    offset: 0,
    comment: '#',
  });

  if (result.didMerge) {
    fs.writeFileSync(podfilePath, result.contents);
  }
}

module.exports = withSentryBuildForDistribution;
