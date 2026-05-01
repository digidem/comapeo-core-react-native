// Metro config mirrors apps/example: blocks the parent node_modules
// copies of react / react-native (peer-dep duplication) and points
// autolinking at the working tree of @comapeo/core-react-native via
// `extraNodeModules` + `watchFolders`.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

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
