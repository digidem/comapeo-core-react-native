import MagicString from "magic-string";
import path from "path";

/**
 * iOS-only addon loader rewrite plugin.
 *
 * Phase 1 / Android: native addons ship as loose `.node` files at known
 * paths under `nodejs-project/node_modules/<pkg>/prebuilds/...`. The
 * existing `rollup-plugin-native-paths.js` patches the three loader
 * patterns (`require('bindings')(...)`, `require('node-gyp-build')(...)`,
 * `require.addon(...)`) so they walk into those paths via the bare
 * resolvers and Node ends up dlopening from the JS-level filesystem.
 *
 * Phase 2 / iOS: native addons ship as code-signed xcframeworks
 * embedded under `<App>.app/Frameworks/`. The bare resolvers can't reach
 * them — the embedded path isn't on any module-resolution search path
 * Node knows about. So instead of *adjusting* the loader call, we
 * *replace* it: each loader pattern becomes a call to
 * `__loadAddon(<package-name>)`, which `process.dlopen`s the
 * pre-positioned framework binary at
 * `NATIVE_LIB_DIR/<name>.framework/<name>` and caches the result.
 *
 * The runtime helper itself ships via the bundle's `output.banner` (see
 * `iosAddonLoaderBanner`) so it lives at the top of the rolled-up file
 * and exists before any module-level loader call runs.
 *
 * Better-sqlite3 is a special case: it doesn't load eagerly via these
 * patterns. We patch `@comapeo/core` (see `backend/patches/`) to pass
 * an externally-loaded addon into better-sqlite3's existing
 * `nativeBinding` constructor option, bypassing its internal
 * `require('bindings')` entirely. The rollup rewrite below still runs
 * over `database.js`'s `require('bindings')('better_sqlite3.node')`
 * call because the dead branch is still present in the bundle, but it
 * never executes when the patched callsite supplies the addon.
 *
 * @returns {import('rollup').Plugin}
 */
export default function iosAddonLoaderPlugin() {
  /** @type {Array<{ pattern: RegExp, replacement: (packageName: string) => string }>} */
  const replacements = [
    {
      // node-bindings as used by better-sqlite3: require('bindings')('foo.node')
      // Backreference `\2` matches the same quote style for the inner arg —
      // mirrors `rollup-plugin-native-paths.js` so both rewrites cover the
      // exact same callsites.
      pattern: /require\(['"]bindings['"]\)\(((['"]).+?\2)?\)/g,
      replacement: (packageName) => `__loadAddon('${packageName}')`,
    },
    {
      pattern: /require\(['"]node-gyp-build['"]\)\(__dirname\)/g,
      replacement: (packageName) => `__loadAddon('${packageName}')`,
    },
    {
      pattern: /require\.addon\(['"]\.['"],\s+__filename\)/g,
      replacement: (packageName) => `__loadAddon('${packageName}')`,
    },
  ];

  return {
    name: "rollup-plugin-ios-addon-loader",

    /**
     * @param {string} code
     * @param {string} id
     */
    transform(code, id) {
      const packageName = getPackageName(id);
      if (!packageName) return null;

      const magicString = new MagicString(code);
      for (const { pattern, replacement } of replacements) {
        magicString.replaceAll(pattern, replacement(packageName));
      }
      if (!magicString.hasChanged()) return null;

      return {
        code: magicString.toString(),
        map: magicString.generateMap({ hires: true }),
      };
    },
  };
}

/**
 * Banner for the iOS rollup output. Defines `__loadAddon(name)` and
 * exposes it on `globalThis` so non-bundled code (e.g. our patched
 * `@comapeo/core` reaching for it via `globalThis.__loadAddon` from
 * `backend/lib/create-comapeo.js`) can also reach the cached addons.
 *
 * `process.dlopen` lands in `__App__.app/Frameworks/<name>.framework/<name>`
 * — Xcode's Embed & Sign phase populates Frameworks/ at app build time
 * from the xcframeworks emitted by `scripts/build-backend.ts`.
 * `NATIVE_LIB_DIR` is set by Swift in `NodeJSService.runNode` before
 * `NodeMobileStartNode` returns control to the bundle.
 *
 * Using string concatenation rather than `path.join` avoids needing a
 * `createRequire`/`import` dance in the banner — iOS is POSIX, so `/`
 * is fine.
 *
 * @type {string}
 */
export const iosAddonLoaderBanner = [
  "const __nativeLibDir = process.env.NATIVE_LIB_DIR;",
  "const __addonCache = new Map();",
  "function __loadAddon(name) {",
  "  const cached = __addonCache.get(name);",
  "  if (cached) return cached;",
  "  const mod = { exports: {} };",
  "  process.dlopen(mod, __nativeLibDir + '/' + name + '.framework/' + name);",
  "  __addonCache.set(name, mod.exports);",
  "  return mod.exports;",
  "}",
  "globalThis.__loadAddon = __loadAddon;",
].join("\n");

// Vendored from https://github.com/i-like-robots/get-package-name/blob/d9f819b/index.js

/**
 * @param {string} modulePath Path to a module file
 * @param {string} [packageFolder="node_modules"] The dependency folder name
 * @return {string | undefined} The package name if it is found or undefined
 */
function getPackageName(modulePath, packageFolder = "node_modules") {
  if (typeof modulePath === "string" && modulePath.includes(packageFolder)) {
    const segments = modulePath.split(path.sep);
    const index = segments.lastIndexOf(packageFolder);

    if (index > -1) {
      const name = segments[index + 1] || "";
      const scopedName = segments[index + 2] || "";

      if (name[0] === "@") {
        return scopedName ? `${name}/${scopedName}` : undefined;
      }

      if (name) {
        return name;
      }
    }
  }
}
