// Learn more https://docs.expo.io/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

// npm v7+ will install ../node_modules/react and ../node_modules/react-native because of peerDependencies.
// To prevent the incompatible react-native between ./node_modules/react-native and ../node_modules/react-native,
// excludes the one from the parent folder when bundling.
//
// Same applies to @sentry/* — a duplicated `@sentry/core` would
// give us two `getGlobalScope()` singletons (one for the host
// app's `Sentry.init`, one for `@comapeo/core-react-native`'s
// adapter writes), and tags / event processors written from one
// would never appear on events captured from the other.
config.resolver.blockList = [
  ...Array.from(config.resolver.blockList ?? []),
  new RegExp(path.resolve('../..', 'node_modules', 'react')),
  new RegExp(path.resolve('../..', 'node_modules', 'react-native')),
  new RegExp(path.resolve('../..', 'node_modules', '@sentry')),
];

config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, './node_modules'),
  path.resolve(__dirname, '../../node_modules'),
];

config.resolver.extraNodeModules = {
  '@comapeo/core-react-native': '../..',
};

config.watchFolders = [path.resolve(__dirname, '../..')];

config.transformer.getTransformOptions = async () => ({
  transform: {
    experimentalImportSupport: false,
    inlineRequires: true,
  },
});

module.exports = config;
