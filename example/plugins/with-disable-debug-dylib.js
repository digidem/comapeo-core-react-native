// Workaround for an Expo SDK 53 / React Native 0.79 + Xcode 16+ interaction.
//
// Xcode 16 flipped the default of ENABLE_DEBUG_DYLIB_SUPPORT to YES for iOS
// app targets, which splits the main executable into a stub binary that
// dlopens a runtime dylib. Under that layout, RCTBundleURLProvider's
// [NSBundle mainBundle] lookups resolve to the wrong bundle, so RN never
// fetches a bundle URL from Metro — the app launches to a blank screen
// with no dev menu and no bundle request in the Metro terminal.
//
// Expo's prebuild template as of SDK 53 doesn't set this explicitly, so we
// pin ENABLE_DEBUG_DYLIB_SUPPORT=NO on every app-target build config. Once
// Expo/RN address the underlying incompatibility upstream, remove this
// plugin from app.json.
const { withXcodeProject } = require('@expo/config-plugins');

module.exports = function withDisableDebugDylib(config) {
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const targets = project.pbxNativeTargetSection();
    const buildConfigs = project.pbxXCBuildConfigurationSection();
    const configLists = project.pbxXCConfigurationList();

    for (const uuid of Object.keys(targets)) {
      const target = targets[uuid];
      if (
        typeof target !== 'object' ||
        target.productType !== '"com.apple.product-type.application"'
      ) {
        continue;
      }
      const listUuid = target.buildConfigurationList;
      const list = configLists[listUuid];
      for (const ref of list.buildConfigurations) {
        buildConfigs[ref.value].buildSettings.ENABLE_DEBUG_DYLIB_SUPPORT = 'NO';
      }
    }
    return cfg;
  });
};
