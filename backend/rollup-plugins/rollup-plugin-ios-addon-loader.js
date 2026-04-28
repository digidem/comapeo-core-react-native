import MagicString from "magic-string";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
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
 * file being transformed — not a hand-maintained map. Top-level free-
 * form `__loadAddon(literal-name)` calls (currently only one, in
 * `backend/lib/create-comapeo.js`, for `better-sqlite3`'s
 * `nativeBinding` plumbing) resolve via Node's normal module resolution
 * from the importer; same answer Node would give at runtime if it ran
 * `require.resolve('better-sqlite3')`.
 *
 * The runtime helper itself ships via the bundle's `output.banner` (see
 * `iosAddonLoaderBanner`) so it lives at the top of the rolled-up file
 * and exists before any module-level loader call runs.
 *
 * Better-sqlite3 is a special case: it doesn't load eagerly via these
 * patterns. We patch `@comapeo/core` (see `backend/patches/`) to pass
 * an externally-loaded addon into better-sqlite3's existing
 * `nativeBinding` constructor option, bypassing its internal
 * node-bindings lookup entirely. The rollup rewrite below still runs
 * over `database.js`'s `require('bindings')(...)` call because the dead
 * branch is still present in the bundle, but it never executes when
 * the patched callsite supplies the addon.
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

  // Free-form `__loadAddon('name')` — single string-literal argument,
  // any receiver context (optional chain, JSDoc cast, etc). Used in
  // `backend/lib/create-comapeo.js` to hand the better-sqlite3 addon
  // module to MapeoManager's `betterSqlite3NativeBinding` option.
  // Source code can't know the version; the plugin injects it by
  // resolving the name from the importer's location at transform time.
  //
  // The single-arg shape disambiguates from the two-arg form the
  // loader-pattern rewrites above produce (`__loadAddon('n', 'v')`),
  // so order doesn't matter — we won't double-rewrite.
  const FREE_FORM_LOAD_ADDON =
    /\b__loadAddon(\?\.)?\(\s*(['"])([^'"]+)\2\s*\)/g;

  // Module name → resolved version cache, keyed per importer dir to
  // honour Node's cascading node_modules lookup for multi-version
  // graphs. Resolution goes through `createRequire(importerFile)` so
  // it follows the same algorithm Node would at runtime.
  /** @type {Map<string, string>} */
  const resolvedVersionCache = new Map();
  function resolveModuleVersion(moduleName, importerFile) {
    const cacheKey = `${importerFile}::${moduleName}`;
    const cached = resolvedVersionCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const requireFromImporter = createRequire(importerFile);
    const pkgJsonPath = requireFromImporter.resolve(
      `${moduleName}/package.json`,
    );
    const version = JSON.parse(readFileSync(pkgJsonPath, "utf-8")).version;
    resolvedVersionCache.set(cacheKey, version);
    return version;
  }

  return {
    name: "rollup-plugin-ios-addon-loader",

    /**
     * @param {string} code
     * @param {string} id
     */
    transform(code, id) {
      const containingPackage = readContainingPackage(id);

      const magicString = new MagicString(code);

      // Loader-pattern rewrites: name + version come from the file's
      // own containing package (the addon is loading itself).
      if (containingPackage) {
        const { name, version } = containingPackage;
        for (const { pattern, replacement } of replacements) {
          magicString.replaceAll(pattern, replacement(name, version));
        }
      }

      // Free-form `__loadAddon('name')` rewrites: version resolved
      // from the importer's perspective. Run on every file whether
      // it's inside a package or not (catches our own backend/lib/*
      // sources).
      FREE_FORM_LOAD_ADDON.lastIndex = 0;
      let match;
      while ((match = FREE_FORM_LOAD_ADDON.exec(code)) !== null) {
        const [full, optionalChain = "", , moduleName] = match;
        const start = match.index;
        const end = start + full.length;
        const version = resolveModuleVersion(moduleName, id);
        magicString.overwrite(
          start,
          end,
          `__loadAddon${optionalChain}('${moduleName}', '${version}')`,
        );
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
 * and exposes it on `globalThis` so non-bundled code (e.g. our patched
 * `@comapeo/core` reaching for it via `globalThis.__loadAddon` from
 * `backend/lib/create-comapeo.js`) can also reach the cached addons.
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
 * install names is unvalidated territory (the canonical plan
 * proposes it; the Phase 2 harness used unversioned names); double
 * underscore is filesystem-safe and unambiguous on every Apple tool
 * we touch.
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
  "globalThis.__loadAddon = __loadAddon;",
].join("\n");

/**
 * Returns the npm package directly containing the file at `id`, by
 * walking parent directories looking for the nearest `package.json`
 * that doesn't sit alongside a `node_modules/` (i.e. the package's
 * own root, not a parent that happens to have node_modules).
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
