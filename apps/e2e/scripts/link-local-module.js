// Idempotently symlink the workspace package — `@comapeo/core-react-native`,
// i.e. the repo root — into this app's node_modules so it resolves through the
// normal node_modules path (which honours the package's `exports` map).
//
// RN 0.85's Metro resolver no longer honours `extraNodeModules` for a package
// that defines an `exports` map: it resolves to an empty module, so every
// export reads back `undefined`. The symlink avoids that for Metro AND makes
// the types resolvable for `tsc` (which has no `paths` alias — see tsconfig.json).
//
// The link is created on demand by whoever loads Metro (metro.config.js) and
// must ALSO run before any typecheck, since `tsc` never loads Metro:
//   * metro.config.js  -> require(...).linkLocalModule()
//   * CI typecheck     -> node scripts/link-local-module.js   (see e2e-reusable.yml)
//
// node_modules is gitignored, so this is regenerated on every fresh checkout.

const fs = require('fs')
const path = require('path')

// This file lives in <app>/scripts/, so:
//   appRoot    = <app>
//   moduleRoot = <app>/../..  (the repo root that IS @comapeo/core-react-native)
function linkLocalModule() {
	const appRoot = path.resolve(__dirname, '..')
	const moduleRoot = path.resolve(appRoot, '..', '..')
	const moduleLink = path.join(
		appRoot,
		'node_modules',
		'@comapeo',
		'core-react-native',
	)
	if (!fs.existsSync(moduleLink)) {
		fs.mkdirSync(path.dirname(moduleLink), { recursive: true })
		fs.symlinkSync(moduleRoot, moduleLink, 'dir')
	}
	return moduleLink
}

module.exports = { linkLocalModule }

// Running it directly (`node scripts/link-local-module.js`) just creates the link.
if (require.main === module) {
	linkLocalModule()
}
