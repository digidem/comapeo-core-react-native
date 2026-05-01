import { rmSync } from "node:fs";
import { cp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import alias from "@rollup/plugin-alias";
import commonjs from "@rollup/plugin-commonjs";
import { default as esmShim } from "@rollup/plugin-esm-shim";
import json from "@rollup/plugin-json";
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
 * `BENCH=1` switches this config to emit the bench-only bundle
 * (`index.bench.js`) into the bench-specific output trees:
 *   - `android/src/bench/assets/nodejs-project/` (selected by the
 *      module's `android/build.gradle` when the `comapeoBench` Gradle
 *      property is set — this replaced the earlier productFlavor
 *      approach to dodge AGP variant ambiguity)
 *   - `ios/nodejs-project-bench/` (picked up by `ComapeoCore.podspec`
 *      iff `ENV['COMAPEO_BENCH']` is set at pod install time; the
 *      podspec also stages a copy at `ios/.bench-staging/nodejs-project/`
 *      so CocoaPods rsyncs it on top of the production bundle)
 *
 * Default (no env var) is unchanged: production `index.js` to the
 * existing main/debug/iOS paths.
 */
const IS_BENCH = process.env.BENCH === "1";

const ANDROID_BENCH_OUT =
  process.env.OUTPUT_DIR_ANDROID_BENCH ??
  path.join(__dirname, "dist/android/bench");

const IOS_BENCH_OUT =
  process.env.OUTPUT_DIR_IOS_BENCH ?? path.join(__dirname, "dist/ios/bench");

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
 * Bench-bundle static assets. The bench backend doesn't import
 * `@comapeo/core` so none of the production runtime data files
 * (drizzle SQL, default-categories zip, fallback map) are reachable
 * from `index.bench.js`. Only the `package.json` is needed — Node's
 * module resolver reads it to set the unpacked tree's module type.
 */
const BENCH_STATIC_ASSET_PATHS = ["package.json"] as const;

/**
 * Copies the static asset paths from `backend/` into `outDir` after the
 * rollup write completes. Replaces the per-platform staging copy that
 * `scripts/build-backend.ts` used to do.
 */
function copyStaticAssetsPlugin(outDir: string, paths: readonly string[]): Plugin {
  return {
    name: "copy-static-assets",
    async writeBundle() {
      await Promise.all(
        paths.map((rel) =>
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
  staticAssetPaths,
  isBench,
}: {
  platform: "android" | "ios";
  outDir: string;
  shouldMinify: boolean;
  staticAssetPaths: readonly string[];
  isBench: boolean;
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
    // bundle. See lib/maps-stub.js. Bench bundle doesn't import
    // `@comapeo/core` at all, so no stub is needed.
    ...(platform === "ios" && !isBench ? [stubComapeoMapsPlugin()] : []),
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
    copyStaticAssetsPlugin(outDir, staticAssetPaths),
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

const prodInput = {
  index: path.join(__dirname, "index.js"),
};

const benchInput = {
  index: path.join(__dirname, "index.bench.js"),
};

const sharedOutput: OutputOptions = {
  format: "esm",
  sourcemap: true,
  entryFileNames: "[name].mjs",
};

/**
 * Production: three outputs from the same source tree (Android debug,
 * Android release, iOS). Android gets the full bundle — its
 * nodejs-mobile build permits JIT, so undici (and therefore the maps
 * fastify plugin) loads cleanly. iOS gets the same bundle but with
 * `@comapeo/core`'s maps plugin swapped for a no-op (see
 * lib/maps-stub.js) because nodejs-mobile iOS runs V8 with `--jitless`
 * and undici's WebAssembly init would crash module load.
 *
 * Bench: a separate two-output mode keyed off `BENCH=1`. Same banner /
 * loader machinery so the native addon system works identically, but
 * the entry is `index.bench.js` (which doesn't import `@comapeo/core`)
 * and the static-asset copy is trimmed to just `package.json`. Bench
 * outputs land in flavor-specific paths (`android/src/bench/...`,
 * `ios/nodejs-project-bench/`) that production consumers never see;
 * see android/build.gradle and ios/ComapeoCore.podspec for the
 * consumer-side wiring.
 *
 * Each output's `banner` defines `__loadAddon(name, version)` with the
 * platform-appropriate `process.dlopen` target — Android does
 * bare-name dlopen against the APK mmap region, iOS dlopen's the
 * Embed-&-Sign'd xcframework binary at NATIVE_LIB_DIR/<key>.framework/<key>.
 * See `rollup-plugin-addon-loader.js` for the helper bodies.
 */
const prodConfig: RollupOptions[] = [
  {
    input: prodInput,
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
        staticAssetPaths: STATIC_ASSET_PATHS,
        isBench: false,
      }),
    ],
  },
  {
    input: prodInput,
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
        staticAssetPaths: STATIC_ASSET_PATHS,
        isBench: false,
      }),
    ],
  },
  {
    input: prodInput,
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
        staticAssetPaths: STATIC_ASSET_PATHS,
        isBench: false,
      }),
    ],
  },
];

const benchConfig: RollupOptions[] = [
  {
    input: benchInput,
    output: {
      ...sharedOutput,
      dir: ANDROID_BENCH_OUT,
      banner: androidAddonLoaderBanner,
    },
    plugins: [
      cleanOutputDirPlugin(ANDROID_BENCH_OUT),
      ...buildPlugins({
        platform: "android",
        outDir: ANDROID_BENCH_OUT,
        shouldMinify: true,
        staticAssetPaths: BENCH_STATIC_ASSET_PATHS,
        isBench: true,
      }),
    ],
  },
  {
    input: benchInput,
    output: {
      ...sharedOutput,
      dir: IOS_BENCH_OUT,
      banner: iosAddonLoaderBanner,
    },
    plugins: [
      cleanOutputDirPlugin(IOS_BENCH_OUT),
      ...buildPlugins({
        platform: "ios",
        outDir: IOS_BENCH_OUT,
        shouldMinify: true,
        staticAssetPaths: BENCH_STATIC_ASSET_PATHS,
        isBench: true,
      }),
    ],
  },
];

export default IS_BENCH ? benchConfig : prodConfig;
