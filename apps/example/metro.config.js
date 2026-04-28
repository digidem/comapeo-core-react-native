// Learn more https://docs.expo.io/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

// npm v7+ will install ../node_modules/react and ../node_modules/react-native because of peerDependencies.
// To prevent the incompatible react-native between ./node_modules/react-native and ../node_modules/react-native,
// excludes the one from the parent folder when bundling.
config.resolver.blockList = [
  ...Array.from(config.resolver.blockList ?? []),
  new RegExp(path.resolve('../..', 'node_modules', 'react')),
  new RegExp(path.resolve('../..', 'node_modules', 'react-native')),
];

config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, './node_modules'),
  path.resolve(__dirname, '../../node_modules'),
];

config.resolver.extraNodeModules = {
<<<<<<< HEAD:apps/example/metro.config.js
  '@comapeo/core-react-native': '../..',
||||||| parent of 126cd87 (initial attempt):example/metro.config.js
  '@comapeo/core-react-native': '..',
=======
  '@comapeo/core-react-native': '..',
  // https://github.com/expo/expo/issues/44647
  'expo-modules-core': path.join(
    __dirname,
    './node_modules/expo/node_modules/expo-modules-core',
  ),
>>>>>>> 126cd87 (initial attempt):example/metro.config.js
};

config.watchFolders = [path.resolve(__dirname, '../..')];

config.transformer.getTransformOptions = async () => ({
  transform: {
    experimentalImportSupport: false,
    inlineRequires: true,
  },
});

module.exports = config;
