// Learn more https://docs.expo.io/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config')
const path = require('path')

const config = getDefaultConfig(__dirname)

// npm v7+ will install ../node_modules/react and ../node_modules/react-native because of peerDependencies.
// To prevent the incompatible react-native between ./node_modules/react-native and ../node_modules/react-native,
// excludes the one from the parent folder when bundling.
config.resolver.blockList = [
	...Array.from(config.resolver.blockList ?? []),
	new RegExp(path.resolve('..', '..', 'node_modules', 'react')),
	new RegExp(path.resolve('..', '..', 'node_modules', 'react-native')),
]

config.resolver.nodeModulesPaths = [
	path.resolve(__dirname, './node_modules'),
	path.resolve(__dirname, '..', '..', './node_modules'),
]

// RN 0.85's Metro resolver no longer honours `extraNodeModules` for a
// package that defines an `exports` map: it resolves to an empty module,
// so every export reads back `undefined`. Symlink the workspace package
// into node_modules so Metro resolves it through the normal node_modules
// path (which honours `exports` correctly). Idempotent — runs whenever
// Metro loads its config, including the CI release-bundle step.
const fs = require('fs')
const moduleLink = path.resolve(
	__dirname,
	'node_modules',
	'@comapeo',
	'core-react-native',
)
if (!fs.existsSync(moduleLink)) {
	fs.mkdirSync(path.dirname(moduleLink), { recursive: true })
	fs.symlinkSync(path.resolve(__dirname, '..', '..'), moduleLink, 'dir')
}

config.watchFolders = [path.resolve(__dirname, '..', '..')]

config.transformer.getTransformOptions = async () => ({
	transform: {
		experimentalImportSupport: true,
		inlineRequires: true,
	},
})

module.exports = config
