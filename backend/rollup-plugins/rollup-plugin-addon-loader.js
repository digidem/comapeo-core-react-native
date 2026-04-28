import MagicString from "magic-string";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Native-addon loader-pattern rewrite plugin. Platform-agnostic.
 *
 * Phase 1 (both platforms) shipped native `.node` files at known paths
 * under `nodejs-project/node_modules/<pkg>/prebuilds/...`, and the
 * legacy `rollup-plugin-native-paths.js` patched the three loader
 * patterns (`require('bindings')(...)`, `require('node-gyp-build')(...)`,
 * `require.addon(...)`) so they walked into those paths via the bare
 * resolvers. `process.dlopen` ended up loading from `filesDir` after
 * a runtime asset extraction.
 *
 * Phase 2 ships native code via the platform's standard packaging
 * (Android `jniLibs/<abi>/lib<name>__<version>.so` mmap'd from the
 * APK, iOS `<name>__<version>.xcframework` Embed-&-Sign'd into
 * `<App>.app/Frameworks/`). The bare resolvers can't reach either
 * location — neither is on a module-resolution search path Node knows
 * about. So instead of *adjusting* the loader call to walk into the
 * right node_modules path, we *replace* it: each loader pattern
 * becomes a call to `__loadAddon(<package-name>, <package-version>)`,
 * which the platform-specific runtime helper `process.dlopen`s
 * appropriately. See `iosAddonLoaderBanner` /
 * `androidAddonLoaderBanner` below — those wire the helper into the
 * top of each platform's bundle.
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
 * loads our prebuilt addon via `__loadAddon('better-sqlite3', '<ver>')`.
 * No special handling needed beyond the standard loader-pattern rewrite
 * — the underscore-vs-hyphen mismatch (`better_sqlite3.node` filename
 * vs. `better-sqlite3` package name) only mattered when we let the
 * original call run; the rewrite replaces the call entirely.
 *
 * @returns {import('rollup').Plugin}
 */
export default function addonLoaderPlugin() {
  /** @type {Array<{ pattern: RegExp, replacement: (packageName: string, packageVersion: string) => string }>} */
  const replacements = [
    {
      // node-bindings as used by better-sqlite3: require('bindings')('foo.node').
      // Backreference `\2` matches the same quote style for the inner arg.
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

  // Per-directory cache for `readContainingPackage` lookups. The walk
  // is invoked once per transformed file, and a typical bundle pulls
  // many sibling files from the same package — without a cache the
  // plugin re-walks the same path tree thousands of times in a build.
  // Scoped to the plugin closure so the cache lives for one rollup
  // run; misses (`null`) are cached too, so repeat lookups against a
  // file outside any package skip the directory walk.
  /** @type {Map<string, { name: string, version: string, dir: string } | null>} */
  const packageCache = new Map();

  return {
    name: "rollup-plugin-addon-loader",

    /**
     * @param {string} code
     * @param {string} id
     */
    transform(code, id) {
      const containingPackage = readContainingPackage(id, packageCache);
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
 * so the loader-pattern rewrites have a callable helper from the very
 * first line of the bundle.
 *
 * `process.dlopen` lands in
 * `<App>.app/Frameworks/<name>__<version>.framework/<name>__<version>`
 * — Xcode's Embed & Sign phase populates `Frameworks/` at app build
 * time from the xcframeworks emitted by `scripts/build-backend.ts`.
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
 * Banner for the Android rollup output. Defines `__loadAddon(name, version)`
 * the same way iOS does, but `process.dlopen`s a bare filename
 * `lib<name>__<version>.so` — no path. Bionic's per-app linker
 * namespace resolves the bare name against the APK's `lib/<abi>/`
 * mmap region when the manifest has `extractNativeLibs="false"` and
 * AGP keeps the libs uncompressed via `useLegacyPackaging=false`.
 * Validated end-to-end by
 * `digidem/nodejs-mobile-bare-prebuilds@feat/jnilibs-xcframework-packaging`'s
 * Android test harness (canonical plan §0.1: a *full-path* `dlopen`
 * against `getApplicationInfo().nativeLibraryDir` would *fail* under
 * `extractNativeLibs="false"` because no `.so` is on disk at any
 * resolvable path — bare-name dlopen against the APK mmap is the
 * only thing that works).
 *
 * Same `__` separator as iOS for symmetry. `.so` filenames take it
 * fine; AGP doesn't impose an alphanumeric-only rule the way Apple's
 * `CFBundleIdentifier` does, so no sanitisation is needed.
 *
 * @type {string}
 */
export const androidAddonLoaderBanner = [
  "const __addonCache = new Map();",
  "function __loadAddon(name, version) {",
  "  const key = name + '__' + version;",
  "  const cached = __addonCache.get(key);",
  "  if (cached) return cached;",
  "  const mod = { exports: {} };",
  "  process.dlopen(mod, 'lib' + key + '.so');",
  "  __addonCache.set(key, mod.exports);",
  "  return mod.exports;",
  "}",
].join("\n");

/**
 * Returns the npm package directly containing the file at `id`, by
 * walking parent directories looking for the nearest `package.json`
 * with both `name` and `version` fields. Stops at the `node_modules`
 * ancestor boundary so a malformed inner `package.json` (e.g. the
 * `{"type": "module"}` pattern some packages use to flag an ESM
 * subdirectory) can't cause the walk to leak into a parent package
 * Node's resolver wouldn't consider this file part of.
 *
 * Memoized per-directory via the supplied `cache` map (per-plugin-run).
 * Misses are cached too — repeat lookups against a file outside any
 * package short-circuit instead of re-walking.
 *
 * @param {string} id Absolute path to a JS source file.
 * @param {Map<string, { name: string, version: string, dir: string } | null>} cache
 * @returns {{ name: string, version: string, dir: string } | null}
 */
function readContainingPackage(id, cache) {
  if (typeof id !== "string" || !path.isAbsolute(id)) return null;
  /** @type {string[]} */
  const visited = [];
  let dir = path.dirname(id);
  while (true) {
    const cached = cache.get(dir);
    if (cached !== undefined) {
      // Propagate the answer to every directory we walked through.
      for (const v of visited) cache.set(v, cached);
      return cached;
    }
    visited.push(dir);

    const pkgPath = path.join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (pkg.name && pkg.version) {
          const result = { name: pkg.name, version: pkg.version, dir };
          for (const v of visited) cache.set(v, result);
          return result;
        }
      } catch {
        // unreadable / unparseable — keep walking.
      }
    }

    const parent = path.dirname(dir);
    // Stop at the `node_modules` ancestor boundary. Node's module
    // resolution treats each `node_modules/<pkg>/` subtree as an
    // independent package; if we got here without finding a valid
    // package.json, the file isn't inside any package and walking
    // further would cross into an unrelated parent.
    if (parent === dir || path.basename(parent) === "node_modules") {
      for (const v of visited) cache.set(v, null);
      return null;
    }
    dir = parent;
  }
}
