// Learn more https://docs.expo.io/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

// Resolve react / react-native from this app's node_modules only — block the
// copies installed at the parent (the native module's) node_modules to avoid
// duplicate-peer crashes when Metro bundles.
config.resolver.blockList = [
  ...Array.from(config.resolver.blockList ?? []),
  new RegExp(path.resolve('..', 'node_modules', 'react')),
  new RegExp(path.resolve('..', 'node_modules', 'react-native')),
];

config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, './node_modules'),
  path.resolve(__dirname, '../node_modules'),
];

// Resolve `@comapeo/core-react-native` directly to the parent module's TS
// source so changes are picked up live without running `npm run build` in the
// parent. (The parent's `package.json` main points to a built `build/index.js`
// that doesn't exist in development.)
const parentSrc = path.resolve(__dirname, '..', 'src');
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === '@comapeo/core-react-native') {
    return {
      type: 'sourceFile',
      filePath: path.join(parentSrc, 'index.ts'),
    };
  }
  if (moduleName.startsWith('@comapeo/core-react-native/')) {
    const sub = moduleName.slice('@comapeo/core-react-native/'.length);
    return {
      type: 'sourceFile',
      filePath: path.join(parentSrc, sub),
    };
  }
  return context.resolveRequest(context, moduleName, platform);
};

config.watchFolders = [path.resolve(__dirname, '..')];

config.transformer.getTransformOptions = async () => ({
  transform: {
    experimentalImportSupport: false,
    inlineRequires: true,
  },
});

module.exports = config;
