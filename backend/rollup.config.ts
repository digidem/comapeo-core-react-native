import { rmSync } from "node:fs";
import { cp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import alias from "@rollup/plugin-alias";
import commonjs from "@rollup/plugin-commonjs";
import { default as esmShim } from "@rollup/plugin-esm-shim";
import json from "@rollup/plugin-json";
import { sentryRollupPlugin } from "@sentry/rollup-plugin";
import type { OutputOptions, Plugin, RollupOptions } from "rollup";
import { minify } from "rollup-plugin-esbuild";

import addonLoaderPlugin, {
  androidAddonLoaderBanner,
  iosAddonLoaderBanner,
} from "./rollup-plugins/rollup-plugin-addon-loader.js";
import {
  captureDebugIdsPlugin,
  relocateSourcemapsPlugin,
} from "./rollup-plugins/rollup-plugin-sentry-debug-ids.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
 * iOS-only: redirects undici's `require('../llhttp/llhttp_simd-wasm.js')`
 * call to the non-SIMD wasm module beside it. polywasm 0.2 doesn't
 * implement WASM SIMD (opcode 0xfd) — it compiles the SIMD bytes
 * successfully but throws `Unsupported instruction: 0xFD` lazily on
 * the first export call, which undici's try/catch around `compile`
 * doesn't intercept. Aliasing at bundle time forces the non-SIMD
 * path so the SIMD bytes never reach polywasm.
 */
function aliasUndiciSimdWasmPlugin(): Plugin {
  return {
    name: "alias-undici-simd-wasm",
    resolveId(source, importer) {
      if (
        source === "../llhttp/llhttp_simd-wasm.js" &&
        importer &&
        importer.includes("/undici/lib/dispatcher/")
      ) {
        return path.resolve(path.dirname(importer), "../llhttp/llhttp-wasm.js");
      }
      return null;
    },
  };
}

/**
 * iOS only: redirect `loader.mjs`'s dynamic `import("./index.js")` to
 * `index.ios.js` (the polywasm-installing wrapper that re-imports
 * `index.js`). Without this, rollup resolves the literal `./index.js`
 * specifier from loader.mjs to the source `index.js` and emits a
 * second chunk that bypasses the polywasm install — undici then
 * throws `ReferenceError: WebAssembly is not defined` at module-init
 * inside the loaded backend. Android resolves `./index.js` to the
 * `index.js` entry naturally; the redirect is iOS-specific.
 */
function redirectLoaderIndexToPolywasmEntryPlugin(): Plugin {
  return {
    name: "redirect-loader-index-to-polywasm-entry",
    resolveId(source, importer) {
      if (
        source === "./index.js" &&
        importer &&
        importer.endsWith("/loader.mjs")
      ) {
        return path.join(__dirname, "index.ios.js");
      }
      return null;
    },
  };
}

/**
 * Runtime data files copied alongside the rollup output into the per-
 * platform output dir. Identical for Android and iOS: only the bundled
 * JS differs (iOS prefixes a polywasm bootstrap and aliases undici's
 * SIMD wasm — see `aliasUndiciSimdWasmPlugin` above).
 *
 *   - `package.json`: required by Node's module resolver to set the
 *     unpacked nodejs-project tree's module type.
 *   - `@comapeo/core/drizzle/`: SQL migration files read at runtime by
 *     drizzle-orm.
 *   - `@comapeo/fallback-smp/`: offline fallback map data.
 *
 * The default project config is NOT bundled here — the consuming app
 * supplies it via the Expo plugin (`app.plugin.js`), which drops the
 * `.comapeocat` into the on-device project tree; the backend resolves
 * it from the `defaultConfigPath` argv positional.
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
    // iOS-only: redirect undici's SIMD llhttp wasm to the non-SIMD
    // module so polywasm doesn't trip on opcode 0xfd at runtime. See
    // aliasUndiciSimdWasmPlugin above.
    ...(platform === "ios" ? [aliasUndiciSimdWasmPlugin()] : []),
    // iOS-only: redirect loader.mjs's `import("./index.js")` to the
    // polywasm-installing entry so the polyfill is in place before
    // undici's module-init `WebAssembly.compile`. See
    // redirectLoaderIndexToPolywasmEntryPlugin above.
    ...(platform === "ios"
      ? [redirectLoaderIndexToPolywasmEntryPlugin()]
      : []),
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

// `loader` is the spawn target on both platforms: it parses `--sentry*`
// argv, conditionally dynamic-imports `./lib/sentry-init.js` (which
// brings in `@sentry/node-core` + `@sentry/opentelemetry` + the
// OpenTelemetry SDK) and initialises Sentry, then dynamic-imports
// `./index.mjs` (the platform-appropriate bundle of either
// `index.js` or `index.ios.js`).
const ANDROID_INPUT = {
  loader: path.join(__dirname, "loader.mjs"),
  index: path.join(__dirname, "index.js"),
};

// iOS uses a thin entry that imports `lib/install-polywasm.js` first
// so polywasm replaces the absent `globalThis.WebAssembly` before the
// shared `index.js` (and undici through the maps plugin) is evaluated.
const IOS_INPUT = {
  loader: path.join(__dirname, "loader.mjs"),
  index: path.join(__dirname, "index.ios.js"),
};

const sharedOutput: OutputOptions = {
  format: "esm",
  sourcemap: true,
  entryFileNames: "[name].mjs",
  // `@sentry/node-core` + `@sentry/opentelemetry` + the OpenTelemetry
  // SDK land here (via `./lib/sentry-init.js`), loaded only when the
  // loader's argv check passes.
  chunkFileNames: "chunks/[name]-[hash].mjs",
};

/**
 * Three outputs from the same source tree: Android debug, Android release, and iOS.
 * Android gets the full bundle — its nodejs-mobile build permits JIT, so undici
 * (and therefore the maps fastify plugin) loads cleanly. iOS uses a wrapper
 * entry (`index-ios.js`) that installs polywasm as `globalThis.WebAssembly`
 * before the shared `index.js` runs, so undici can compile its non-SIMD
 * llhttp wasm under nodejs-mobile's jitless V8.
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
    input: ANDROID_INPUT,
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
    input: ANDROID_INPUT,
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
    input: IOS_INPUT,
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
