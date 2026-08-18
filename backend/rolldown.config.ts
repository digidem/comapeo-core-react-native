import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
 * iOS-only: redirect undici's `require('../llhttp/llhttp_simd-wasm.js')` to the
 * non-SIMD module beside it.
 *
 * nodejs-mobile 24 does serve `WebAssembly` from a bundled polywasm on iOS, and
 * its bootstrap sets `UNDICI_NO_WASM_SIMD=1` to steer undici off the SIMD build
 * — but that env var is an undici 7.x feature, so it only reaches Node's
 * *built-in* undici. We bundle npm `undici@6`, which ignores it and calls
 * `WebAssembly.compile(llhttp_simd-wasm)` unconditionally
 * (`dispatcher/client-h1.js`). polywasm compiles function bodies lazily, so
 * that compile *succeeds* and then throws `Unsupported instruction: 0xFD` on
 * the first parser callback — past the try/catch undici wraps the compile in.
 *
 * `@comapeo/core`'s maps plugin and `secret-stream-http` (via
 * `@comapeo/map-server`) both import `fetch` from that bundled copy, so this
 * covers online map styles and peer blob/SMP fetches. Aliasing at bundle time
 * keeps the SIMD bytes out of the iOS bundle entirely.
 */
function aliasUndiciSimdWasmPlugin(outDir: string): Plugin {
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
    // Assert the outcome, not the mechanism: the redirect above is matched on
    // an upstream specifier, so an undici reshuffle turns it into a silent
    // no-op and the SIMD bytes come back. Nothing downstream would notice —
    // the failure needs a real network fetch on a jitless device, which no
    // test in this repo makes.
    writeBundle() {
      const emitted = readEmittedBundle(outDir);
      if (!emitted) return;
      const simd = undiciWasmMarker("llhttp_simd-wasm.js");
      if (simd && emitted.includes(simd)) {
        throw new Error(
          "alias-undici-simd-wasm: the SIMD llhttp payload is in the iOS " +
            "bundle. polywasm compiles it lazily, so it will throw " +
            "`Unsupported instruction: 0xFD` on the first request rather than " +
            "at compile time. The redirect in this plugin no longer matches " +
            "undici's import — update it.",
        );
      }
    },
  };
}

/** Concatenated JS of every chunk written to `outDir`, or null if absent. */
function readEmittedBundle(outDir: string): string | null {
  if (!existsSync(outDir)) return null;
  const files = [
    ...readdirSync(outDir)
      .filter((f) => f.endsWith(".mjs"))
      .map((f) => path.join(outDir, f)),
    ...(existsSync(path.join(outDir, "chunks"))
      ? readdirSync(path.join(outDir, "chunks"))
          .filter((f) => f.endsWith(".mjs"))
          .map((f) => path.join(outDir, "chunks", f))
      : []),
  ];
  return files.length ? files.map((f) => readFileSync(f, "utf8")).join("") : null;
}

/**
 * A slice of `<module>`'s base64 payload that does not appear in its sibling,
 * so it identifies that specific wasm build in a bundle. Returns null when
 * undici isn't installed — the assertion then has nothing to check, which is
 * the correct answer if the dependency ever goes away (see issue #232).
 */
function undiciWasmMarker(module: string): string | null {
  const dir = path.join(__dirname, "node_modules/undici/lib/llhttp");
  const read = (f: string) => {
    const p = path.join(dir, f);
    if (!existsSync(p)) return null;
    return readFileSync(p, "utf8").match(/[A-Za-z0-9+/]{200,}={0,2}/)?.[0] ?? null;
  };
  const target = read(module);
  const sibling = read(
    module === "llhttp_simd-wasm.js" ? "llhttp-wasm.js" : "llhttp_simd-wasm.js",
  );
  if (!target || !sibling) return null;
  let i = 0;
  while (i < Math.min(target.length, sibling.length) && target[i] === sibling[i]) {
    i++;
  }
  // 64 chars past the first divergence is far more than enough to be unique,
  // and short enough to survive minification (these are string literals).
  return target.slice(i, i + 64) || null;
}

/**
 * Runtime data files copied alongside the rolldown output into the per-
 * platform output dir. Identical for Android and iOS; only the bundled JS
 * differs, in the `__loadAddon` banner and the undici SIMD alias above.
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
 *     indirectly.
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
    },
  },
};

function buildPlugins({
  platform,
  outDir,
  debugIdMap,
}: {
  platform: "android" | "ios";
  outDir: string;
  debugIdMap: Map<string, string>;
}): Plugin[] {
  return [
    // iOS-only: keep the SIMD llhttp bytes out of the bundle — the runtime's
    // UNDICI_NO_WASM_SIMD only steers Node's built-in undici, not the npm copy
    // we bundle. See aliasUndiciSimdWasmPlugin above.
    ...(platform === "ios" ? [aliasUndiciSimdWasmPlugin(outDir)] : []),
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
        platform: "android",
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
        platform: "ios",
        outDir: IOS_OUT,
        debugIdMap: iosDebugIds,
      }),
      relocateSourcemapsPlugin(IOS_OUT, IOS_SOURCEMAPS, iosDebugIds),
    ],
  },
];

export default config;
