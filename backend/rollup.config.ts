import { rmSync } from "node:fs";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import alias from "@rollup/plugin-alias";
import commonjs from "@rollup/plugin-commonjs";
import { default as esmShim } from "@rollup/plugin-esm-shim";
import json from "@rollup/plugin-json";
import { isJsFile, stringToUUID } from "@sentry/bundler-plugin-core";
import { sentryRollupPlugin } from "@sentry/rollup-plugin";
import type { OutputOptions, Plugin, RollupOptions } from "rollup";
import { minify } from "rollup-plugin-esbuild";

import addonLoaderPlugin, {
  androidAddonLoaderBanner,
  iosAddonLoaderBanner,
} from "./rollup-plugins/rollup-plugin-addon-loader.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MAPS_STUB_PATH = path.join(__dirname, "lib", "maps-stub.js");

/**
 * Per-platform output dirs. `scripts/build-backend.ts` sets these env
 * vars to write directly into the final native-asset trees
 * (`android/src/debug/assets/nodejs-project/`, `android/src/main/assets/nodejs-project/`, and
 * `ios/nodejs-project/`), skipping the intermediate staging tree the script used to maintain.
 * Falls back to `backend/dist/<platform>/` so `cd backend && npm run build`
 * still produces inspectable output for standalone debugging.
 */
const ANDROID_OUT_DEBUG =
  process.env.OUTPUT_DIR_ANDROID_DEBUG ??
  path.join(__dirname, "dist/android/debug");

const ANDROID_OUT_MAIN =
  process.env.OUTPUT_DIR_ANDROID_MAIN ??
  path.join(__dirname, "dist/android/main");

const IOS_OUT = process.env.OUTPUT_DIR_IOS ?? path.join(__dirname, "dist/ios");

/**
 * Per-platform sourcemap relocation targets. The `.mjs.map` file rollup
 * writes alongside the bundle is moved here after `writeBundle` so it
 * never enters the per-platform asset/resource tree consumed by the
 * APK / IPA builds. The maps still ship in the npm tarball (the parent
 * of these dirs is whitelisted in `package.json`'s `files`) so the
 * `comapeo-rn-upload-sourcemaps` CLI can resolve them at consumer build
 * time.
 *
 * For the production build these are passed by `scripts/build-backend.ts`;
 * the fallbacks keep the standalone `cd backend && npm run build` case
 * working — maps land in `<outDir>-sourcemaps/` next to the bundle dir.
 */
const ANDROID_SOURCEMAPS_DEBUG =
  process.env.SOURCEMAPS_DIR_ANDROID_DEBUG ?? `${ANDROID_OUT_DEBUG}-sourcemaps`;

const ANDROID_SOURCEMAPS_MAIN =
  process.env.SOURCEMAPS_DIR_ANDROID_MAIN ?? `${ANDROID_OUT_MAIN}-sourcemaps`;

const IOS_SOURCEMAPS =
  process.env.SOURCEMAPS_DIR_IOS ?? `${IOS_OUT}-sourcemaps`;

/**
 * Resolves `@comapeo/core`'s `./fastify-plugins/maps.js` import to the
 * iOS-only no-op stub. Scoped tightly to the `@comapeo/core/src/` importer
 * so unrelated packages with a similarly-named file aren't caught.
 */
function stubComapeoMapsPlugin(): Plugin {
  return {
    name: "stub-comapeo-maps-plugin",
    resolveId(source, importer) {
      if (
        source === "./fastify-plugins/maps.js" &&
        importer &&
        importer.includes("@comapeo/core/src/")
      ) {
        return MAPS_STUB_PATH;
      }
      return null;
    },
  };
}

/**
 * Runtime data files copied alongside the rollup output into the per-
 * platform output dir. Identical for Android and iOS: only the bundled
 * JS differs (iOS has the maps fastify plugin stubbed out — see
 * `stubComapeoMapsPlugin` above).
 *
 *   - `package.json`: required by Node's module resolver to set the
 *     unpacked nodejs-project tree's module type.
 *   - `@comapeo/core/drizzle/`: SQL migration files read at runtime by
 *     drizzle-orm.
 *   - `@comapeo/default-categories/.../*.comapeocat`: default project
 *     config zip read at runtime.
 *   - `@comapeo/fallback-smp/`: offline fallback map data.
 *
 * Native module `package.json`/`binding.gyp` are NOT copied. Every
 * loader callsite (`require('bindings')`, `require('node-gyp-build')`,
 * `require.addon()`) is rewritten by `rollup-plugin-addon-loader.js`
 * to `__loadAddon(name, version)` at bundle time, so Bare's addon
 * resolver — the only thing that ever consulted those files — never
 * runs at runtime.
 */
const STATIC_ASSET_PATHS = [
  "package.json",
  "node_modules/@comapeo/core/drizzle",
  "node_modules/@comapeo/default-categories/dist/comapeo-default-categories.comapeocat",
  "node_modules/@comapeo/fallback-smp",
] as const;

/**
 * Copies the static asset paths from `backend/` into `outDir` after the
 * rollup write completes. Replaces the per-platform staging copy that
 * `scripts/build-backend.ts` used to do.
 */
function copyStaticAssetsPlugin(outDir: string): Plugin {
  return {
    name: "copy-static-assets",
    async writeBundle() {
      await Promise.all(
        STATIC_ASSET_PATHS.map((rel) =>
          cp(path.join(__dirname, rel), path.join(outDir, rel), {
            recursive: true,
          }),
        ),
      );
    },
  };
}

function buildPlugins({
  platform,
  outDir,
  shouldMinify,
  debugIdMap,
}: {
  platform: "android" | "ios";
  outDir: string;
  shouldMinify: boolean;
  debugIdMap: Map<string, string>;
}): Plugin[] {
  return [
    alias({
      entries: [
        // @comapeo/core (indirectly) depends on @node-rs/crc32, which can't be rolled up.
        // Replace it with a pure JavaScript implementation.
        {
          find: "@node-rs/crc32",
          replacement: path.join(__dirname, "lib", "node-rs-crc32-shim.js"),
        },
      ],
    }),
    // iOS-only: stub the maps fastify plugin so undici stays out of the
    // bundle. See lib/maps-stub.js.
    ...(platform === "ios" ? [stubComapeoMapsPlugin()] : []),
    // Native addon loader rewrite is identical for both platforms:
    // every loader pattern (`bindings`, `node-gyp-build`, `require.addon`)
    // becomes `__loadAddon(name, version)`. The helper itself differs
    // per output via the platform-specific banner — see `output.banner`
    // entries below.
    addonLoaderPlugin(),
    // @ts-expect-error Types for these rollup plugins are misconfigured: https://github.com/rollup/plugins/issues/1860
    commonjs({ ignoreDynamicRequires: true }),
    // @ts-expect-error Types for these rollup plugins are misconfigured: https://github.com/rollup/plugins/issues/1860
    esmShim(),
    nodeResolve({ preferBuiltins: true }),
    // @ts-expect-error Types for these rollup plugins are misconfigured: https://github.com/rollup/plugins/issues/1860
    json(),
    shouldMinify ? minify() : undefined,
    copyStaticAssetsPlugin(outDir),
    // Capture the debug ID sentry-rollup-plugin will compute for this
    // chunk so `relocateSourcemapsPlugin` can read it directly at
    // writeBundle. Must run *before* sentry-rollup-plugin in
    // renderChunk so both see the same `code` input.
    captureDebugIdsPlugin(debugIdMap),
    // Inject `_sentryDebugIdIdentifier` (runtime snippet) into the
    // bundle so Sentry symbolicates by ID, independent of the consumer's
    // release. Upload is disabled — published tarballs carry the maps;
    // consumers run `comapeo-rn-upload-sourcemaps` from CI to push them
    // to their own Sentry project. Debug IDs are `stringToUUID(chunk.code)`
    // so identical bundle bytes produce identical IDs across re-publishes.
    sentryRollupPlugin({
      sourcemaps: { disable: "disable-upload" },
      telemetry: false,
      release: { inject: false, create: false },
    }),
  ];
}

/**
 * Wipes `dir` before rollup writes — keeps successive builds idempotent
 * (rollup overwrites bundle files but `copyStaticAssetsPlugin` is purely
 * additive, so a stale entry from a previous run could otherwise leak
 * into the output tree).
 */
function cleanOutputDirPlugin(dir: string): Plugin {
  return {
    name: "clean-output-dir",
    buildStart() {
      rmSync(dir, { force: true, recursive: true });
    },
  };
}

/**
 * Captures the debug ID sentry-rollup-plugin will derive for each
 * chunk, by computing it ourselves on the same `code` input.
 * `stringToUUID` is the public helper from `@sentry/bundler-plugin-core`
 * that sentry-rollup-plugin uses internally — calling it on the same
 * bytes produces the same ID by construction. Plugin order matters:
 * this must run *before* `sentryRollupPlugin` in `renderChunk` so we
 * see the same `code` parameter (we return `null` to avoid mutating
 * it).
 *
 * The captured IDs are then read by `relocateSourcemapsPlugin` at
 * `writeBundle`, avoiding a regex scan over the bundle's runtime
 * `_sentryDebugIdIdentifier` snippet — the snippet's exact format is
 * an implementation detail of bundler-plugin-core's runtime SDK
 * contract, but `stringToUUID(code)` is a public, stable helper.
 */
function captureDebugIdsPlugin(idMap: Map<string, string>): Plugin {
  return {
    name: "capture-debug-ids",
    renderChunk(code, chunk) {
      if (!isJsFile(chunk.fileName)) return null;
      idMap.set(chunk.fileName, stringToUUID(code));
      return null;
    },
  };
}

/**
 * Moves `*.map` files out of the rollup output dir into a sibling
 * sourcemap dir after `writeBundle`, injecting `debug_id` (and the
 * legacy `debugId`) into the map JSON on the way through. Keeps the
 * bundle's `//# sourceMappingURL=index.mjs.map` line as a dangling
 * reference — harmless on-device (the runtime never resolves it) and
 * the upload CLI matches map-to-bundle by debug ID, not by adjacency.
 *
 * Why move instead of exclude in the platform packaging:
 *   - Android: gradle `assets.exclude '**\/*.map'` would also work, but
 *     CocoaPods folder references (`s.resources = ['nodejs-project']`)
 *     have no equivalent — there's no public hook to exclude individual
 *     files from a folder ref. Doing the move at build time keeps the
 *     mechanism uniform across platforms.
 *
 * Why inject `debug_id` into the map ourselves (rather than letting
 * sentry-cli do it at upload):
 *   - With `sourcemaps.disable: "disable-upload"` the sentry-rollup-
 *     plugin only writes `_sentryDebugIdIdentifier` into the bundle,
 *     not into the map.
 *   - sentry-cli's debug-ID-based association uses adjacency or
 *     `sourceMappingURL` to find the map for a bundle. Both break once
 *     we relocate, so the map needs the ID embedded directly to be
 *     resolvable from any directory.
 *
 * Both keys are written for back-compat: sentry-cli <2.39 reads
 * `debug_id` (snake_case), 2.39+ reads either, 3.0+ writes `debugId`
 * only. Consumers' sentry-cli pin comes from their @sentry/react-native
 * version, so we can't assume 2.39+.
 *
 * Idempotent: `cleanOutputDirPlugin` wipes `outDir` before the build
 * starts; this plugin wipes its target dir at `writeBundle` time so a
 * stale map from a previous build can't leak through.
 */
function relocateSourcemapsPlugin(
  outDir: string,
  sourcemapDir: string,
  idMap: Map<string, string>,
): Plugin {
  return {
    name: "relocate-sourcemaps",
    async writeBundle() {
      rmSync(sourcemapDir, { force: true, recursive: true });
      await mkdir(sourcemapDir, { recursive: true });
      const entries = await readdir(outDir);
      const mapNames = entries.filter((name) => name.endsWith(".map"));
      await Promise.all(
        mapNames.map(async (name) => {
          const bundleName = name.slice(0, -".map".length);
          const debugId = idMap.get(bundleName);
          if (!debugId) {
            throw new Error(
              `relocate-sourcemaps: no captured debug ID for ${bundleName}; ` +
                "is captureDebugIdsPlugin in plugins[] before sentryRollupPlugin?",
            );
          }
          const bundlePath = path.join(outDir, bundleName);
          const mapSrc = path.join(outDir, name);
          const mapDst = path.join(sourcemapDir, name);
          const [bundleSource, mapSource] = await Promise.all([
            readFile(bundlePath, "utf8"),
            readFile(mapSrc, "utf8"),
          ]);

          // Spec-compliant trailing `//# debugId=` comment. The
          // sentry-rollup-plugin writes `_sentryDebugIdIdentifier`
          // (the runtime snippet) but only adds the trailing comment
          // during its own upload step, which we disabled. Add it
          // here so all sentry-cli versions and other tools that
          // scan for the trailer find the ID. Spec doesn't constrain
          // ordering with `//# sourceMappingURL=`, so just append.
          const patchedBundle = `${bundleSource}\n//# debugId=${debugId}\n`;

          const map = JSON.parse(mapSource);
          map.debug_id = debugId;
          map.debugId = debugId;

          await Promise.all([
            writeFile(bundlePath, patchedBundle, "utf8"),
            writeFile(mapDst, JSON.stringify(map), "utf8"),
          ]);
          await unlink(mapSrc);
        }),
      );
    },
  };
}

const sharedInput = {
  index: path.join(__dirname, "index.js"),
};

const sharedOutput: OutputOptions = {
  format: "esm",
  sourcemap: true,
  entryFileNames: "[name].mjs",
};

/**
 * Three outputs from the same source tree: Android debug, Android release, and iOS.
 * Android gets the full bundle — its nodejs-mobile build permits JIT, so undici
 * (and therefore the maps fastify plugin) loads cleanly. iOS gets the same bundle but with
 * `@comapeo/core`'s maps plugin swapped for a no-op (see lib/maps-stub.js)
 * because nodejs-mobile iOS runs V8 with `--jitless` and undici's
 * WebAssembly init would crash module load.
 *
 * Each output's `banner` defines `__loadAddon(name, version)` with the
 * platform-appropriate `process.dlopen` target — Android does
 * bare-name dlopen against the APK mmap region, iOS dlopen's the
 * Embed-&-Sign'd xcframework binary at NATIVE_LIB_DIR/<key>.framework/<key>.
 * See `rollup-plugin-addon-loader.js` for the helper bodies.
 */
// One Map per output config. Populated by `captureDebugIdsPlugin` in
// `renderChunk` and read by `relocateSourcemapsPlugin` in `writeBundle`.
// Per-config (rather than one shared Map) so a stale entry from a
// previous output can't bleed across — rollup runs the configs
// sequentially.
const androidDebugDebugIds = new Map<string, string>();
const androidMainDebugIds = new Map<string, string>();
const iosDebugIds = new Map<string, string>();

const config: RollupOptions[] = [
  {
    input: sharedInput,
    output: {
      ...sharedOutput,
      dir: ANDROID_OUT_DEBUG,
      banner: androidAddonLoaderBanner,
    },
    plugins: [
      cleanOutputDirPlugin(ANDROID_OUT_DEBUG),
      ...buildPlugins({
        platform: "android",
        outDir: ANDROID_OUT_DEBUG,
        // Android debug does not minify the bundle.
        shouldMinify: false,
        debugIdMap: androidDebugDebugIds,
      }),
      relocateSourcemapsPlugin(
        ANDROID_OUT_DEBUG,
        ANDROID_SOURCEMAPS_DEBUG,
        androidDebugDebugIds,
      ),
    ],
  },
  {
    input: sharedInput,
    output: {
      ...sharedOutput,
      dir: ANDROID_OUT_MAIN,
      banner: androidAddonLoaderBanner,
    },
    plugins: [
      cleanOutputDirPlugin(ANDROID_OUT_MAIN),
      ...buildPlugins({
        platform: "android",
        outDir: ANDROID_OUT_MAIN,
        shouldMinify: true,
        debugIdMap: androidMainDebugIds,
      }),
      relocateSourcemapsPlugin(
        ANDROID_OUT_MAIN,
        ANDROID_SOURCEMAPS_MAIN,
        androidMainDebugIds,
      ),
    ],
  },
  {
    input: sharedInput,
    output: {
      ...sharedOutput,
      dir: IOS_OUT,
      banner: iosAddonLoaderBanner,
    },
    plugins: [
      cleanOutputDirPlugin(IOS_OUT),
      ...buildPlugins({
        platform: "ios",
        outDir: IOS_OUT,
        shouldMinify: true,
        debugIdMap: iosDebugIds,
      }),
      relocateSourcemapsPlugin(IOS_OUT, IOS_SOURCEMAPS, iosDebugIds),
    ],
  },
];

export default config;
