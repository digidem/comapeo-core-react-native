import MagicString from "magic-string";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

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
 * `__loadAddon(<package-name>, <package-version>)`, which
 * `process.dlopen`s the pre-positioned framework binary at
 * `NATIVE_LIB_DIR/<name>__<version>.framework/<name>__<version>` and
 * caches the result keyed by `name__version`.
 *
 * Multi-version safety: when the dep tree carries two versions of the
 * same addon (e.g. `sodium-native@4.3.3` top-level + `@5.1.0` nested
 * under several deps in the current `backend/`), each callsite is
 * rewritten with the version that npm's resolution actually picked for
 * THAT importer. The version comes from the package.json that owns the
 * file being transformed — not a hand-maintained map.
 *
 * Better-sqlite3 specifically: its `database.js` does
 * `require('bindings')('better_sqlite3.node')` lazily, on first
 * `new Database(...)` call. The rewrite catches that callsite at
 * bundle time so when the lazy initialization runs at runtime, it
 * loads our xcframework via `__loadAddon('better-sqlite3', '<ver>')`.
 * No special handling needed beyond the standard loader-pattern rewrite
 * — the underscore-vs-hyphen mismatch (`better_sqlite3.node` filename
 * vs. `better-sqlite3` package name) only mattered when we let the
 * original call run; the rewrite replaces the call entirely.
 *
 * The runtime helper itself ships via the bundle's `output.banner` (see
 * `iosAddonLoaderBanner`) so it lives at the top of the rolled-up file
 * and exists before any module-level loader call runs.
 *
 * @returns {import('rollup').Plugin}
 */
export default function iosAddonLoaderPlugin() {
  /** @type {Array<{ pattern: RegExp, replacement: (packageName: string, packageVersion: string) => string }>} */
  const replacements = [
    {
      // node-bindings as used by better-sqlite3: require('bindings')('foo.node').
      // Backreference `\2` matches the same quote style for the inner arg —
      // mirrors `rollup-plugin-native-paths.js` so both rewrites cover the
      // exact same callsites.
      pattern: /require\(['"]bindings['"]\)\(((['"]).+?\2)?\)/g,
      replacement: (n, v) => `__loadAddon('${n}', '${v}')`,
    },
    {
      pattern: /require\(['"]node-gyp-build['"]\)\(__dirname\)/g,
      replacement: (n, v) => `__loadAddon('${n}', '${v}')`,
    },
    {
      pattern: /require\.addon\(['"]\.['"],\s+__filename\)/g,
      replacement: (n, v) => `__loadAddon('${n}', '${v}')`,
    },
  ];

  return {
    name: "rollup-plugin-ios-addon-loader",

    /**
     * @param {string} code
     * @param {string} id
     */
    transform(code, id) {
      const containingPackage = readContainingPackage(id);
      if (!containingPackage) return null;

      const { name, version } = containingPackage;
      const magicString = new MagicString(code);
      for (const { pattern, replacement } of replacements) {
        magicString.replaceAll(pattern, replacement(name, version));
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
 * Banner for the iOS rollup output. Defines `__loadAddon(name, version)`
 * so the loader-pattern rewrites run at the top of the bundle have a
 * callable helper from the very first line.
 *
 * `process.dlopen` lands in
 * `<App>.app/Frameworks/<name>__<version>.framework/<name>__<version>`
 * — Xcode's Embed & Sign phase populates Frameworks/ at app build time
 * from the xcframeworks emitted by `scripts/build-backend.ts`.
 * `NATIVE_LIB_DIR` is set by Swift in `AppLifecycleDelegate.nodeService`'s
 * `nodeEntryPoint` closure before `NodeMobileStartNode` returns
 * control to the bundle.
 *
 * Cache key is `name + '__' + version` so two callsites that resolve
 * to different versions of the same addon don't share a slot. Using
 * `__` rather than `@` because `@` in framework dir names + Mach-O
 * install names is unvalidated territory; double underscore is
 * filesystem-safe and unambiguous on every Apple tool we touch
 * (with one carve-out: `CFBundleIdentifier` rejects underscores, so
 * `buildFrameworkPlist` in scripts/build-backend.ts substitutes `__`
 * for `-` there only).
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
  "function __loadAddon(name, version) {",
  "  const key = name + '__' + version;",
  "  const cached = __addonCache.get(key);",
  "  if (cached) return cached;",
  "  const mod = { exports: {} };",
  "  process.dlopen(mod, __nativeLibDir + '/' + key + '.framework/' + key);",
  "  __addonCache.set(key, mod.exports);",
  "  return mod.exports;",
  "}",
].join("\n");

/**
 * Returns the npm package directly containing the file at `id`, by
 * walking parent directories looking for the nearest `package.json`
 * with both `name` and `version` fields.
 *
 * @param {string} id Absolute path to a JS source file.
 * @returns {{ name: string, version: string, dir: string } | null}
 */
function readContainingPackage(id) {
  if (typeof id !== "string" || !path.isAbsolute(id)) return null;
  let dir = path.dirname(id);
  while (true) {
    const pkgPath = path.join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (pkg.name && pkg.version) {
          return { name: pkg.name, version: pkg.version, dir };
        }
      } catch {
        // unreadable / unparseable — keep walking.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
