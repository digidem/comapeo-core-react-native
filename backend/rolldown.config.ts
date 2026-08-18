import { rmSync } from "node:fs";
import { cp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sentryRollupPlugin } from "@sentry/rollup-plugin";
import type {
  InputOptions,
  OutputOptions,
  Plugin,
  RolldownOptions,
} from "rolldown";

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
 * (`android/src/main/assets/nodejs-project/` and `ios/nodejs-project/`),
 * skipping the intermediate staging tree the script used to maintain.
 * Falls back to `backend/dist/<platform>/` so `cd backend && npm run build`
 * still produces inspectable output for standalone debugging.
 */
const ANDROID_OUT_MAIN =
  process.env.OUTPUT_DIR_ANDROID_MAIN ??
  path.join(__dirname, "dist/android/main");

const IOS_OUT = process.env.OUTPUT_DIR_IOS ?? path.join(__dirname, "dist/ios");

/**
 * Per-platform sourcemap relocation targets. The `.mjs.map` file rolldown
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
const ANDROID_SOURCEMAPS_MAIN =
  process.env.SOURCEMAPS_DIR_ANDROID_MAIN ?? `${ANDROID_OUT_MAIN}-sourcemaps`;

const IOS_SOURCEMAPS =
  process.env.SOURCEMAPS_DIR_IOS ?? `${IOS_OUT}-sourcemaps`;

/**
 * Runtime data files copied alongside the rolldown output into the per-
 * platform output dir. Identical for Android and iOS; only the bundled JS
 * differs, in the `__loadAddon` banner.
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
  "node_modules/comapeo-core-old/drizzle",
  "node_modules/@comapeo/fallback-smp",
] as const;

/**
 * Copies the static asset paths from `backend/` into `outDir` after the
 * rolldown write completes. Replaces the per-platform staging copy that
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

/**
 * Shared resolver config. Replaces `@rollup/plugin-node-resolve` and
 * `@rollup/plugin-alias` with rolldown's built-in resolver:
 *
 *   - `platform: "node"` is rolldown's equivalent of node-resolve's
 *     `preferBuiltins: true` — `node:`-prefixed and bare builtin
 *     specifiers resolve to the runtime builtin rather than a polyfill.
 *   - `resolve.alias` swaps `@node-rs/crc32` (a native addon that can't
 *     be rolled up) for a pure-JS shim. `@comapeo/core` pulls it in
 *     indirectly. `undici` is aliased the same way — Node 24 embeds it,
 *     so the npm copy `@comapeo/core` and `secret-stream-http` import is
 *     389 KB of duplicate bundle (see `lib/undici-shim.js`).
 *
 * CommonJS and JSON inputs are handled by rolldown natively, so the
 * former `@rollup/plugin-commonjs`, `@rollup/plugin-json`, and
 * `@rollup/plugin-esm-shim` plugins are gone. Unresolvable dynamic
 * `require()` calls are left intact (the old `ignoreDynamicRequires`
 * behaviour) and serviced at runtime by rolldown's `require` polyfill.
 */
const sharedInput: Pick<InputOptions, "platform" | "resolve"> = {
  platform: "node",
  resolve: {
    alias: {
      "@node-rs/crc32": path.join(__dirname, "lib", "node-rs-crc32-shim.js"),
      undici: path.join(__dirname, "lib", "undici-shim.js"),
    },
  },
};

function buildPlugins({
  outDir,
  debugIdMap,
}: {
  outDir: string;
  debugIdMap: Map<string, string>;
}): Plugin[] {
  return [
    // Native addon loader rewrite is identical for both platforms:
    // every loader pattern (`bindings`, `node-gyp-build`, `require.addon`)
    // becomes `__loadAddon(name, version)`. The helper itself differs
    // per output via the platform-specific banner — see `output.banner`
    // entries below.
    addonLoaderPlugin(),
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
 * Wipes `dir` before rolldown writes — keeps successive builds idempotent
 * (rolldown overwrites bundle files but `copyStaticAssetsPlugin` is purely
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
// `./index.mjs`.
const INPUT = {
  loader: path.join(__dirname, "loader.mjs"),
  index: path.join(__dirname, "index.js"),
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
 * Two outputs from the same source tree and the same entries: Android and
 * iOS. They differ only in the `__loadAddon` banner.
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
// previous output can't bleed across — rolldown runs the configs
// sequentially.
const androidMainDebugIds = new Map<string, string>();
const iosDebugIds = new Map<string, string>();

const config: RolldownOptions[] = [
  {
    input: INPUT,
    ...sharedInput,
    output: {
      ...sharedOutput,
      dir: ANDROID_OUT_MAIN,
      banner: androidAddonLoaderBanner,
      minify: true,
    },
    plugins: [
      cleanOutputDirPlugin(ANDROID_OUT_MAIN),
      ...buildPlugins({
        outDir: ANDROID_OUT_MAIN,
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
    input: INPUT,
    ...sharedInput,
    output: {
      ...sharedOutput,
      dir: IOS_OUT,
      banner: iosAddonLoaderBanner,
      minify: true,
    },
    plugins: [
      cleanOutputDirPlugin(IOS_OUT),
      ...buildPlugins({
        outDir: IOS_OUT,
        debugIdMap: iosDebugIds,
      }),
      relocateSourcemapsPlugin(IOS_OUT, IOS_SOURCEMAPS, iosDebugIds),
    ],
  },
];

export default config;
