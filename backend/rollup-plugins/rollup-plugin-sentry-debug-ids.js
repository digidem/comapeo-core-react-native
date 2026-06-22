// `@sentry/rollup-plugin` injects the `_sentryDebugIdIdentifier` snippet into
// the bundle so the Sentry runtime SDK can attach the right debug ID to events,
// but it doesn't add a `//# debugId=` trailer to the bundle, nor
// `debug_id`/`debugId` to the sourcemap — both of those normally happen during
// the plugin's own upload step, which we disable so consumers can run their own
// upload.
//
// `captureDebugIdsPlugin` runs in `renderChunk` *before* sentry-rollup-
// plugin and computes the same debug ID by calling the shared
// `stringToUUID(code)` helper from `@sentry/bundler-plugin-core` on the
// same `code` parameter. The IDs match by construction. Captures land
// in a `Map<chunkFileName, debugId>` shared with the relocator.
//
// `relocateSourcemapsPlugin` runs in `writeBundle`, where it:
//   - reads the captured debug ID for each emitted chunk;
//   - asserts the ID appears in the bundle (catches plugin-order bugs
//     and future algorithm drift in `stringToUUID`);
//   - appends the `//# debugId=` trailer to the bundle;
//   - splices `"debug_id"` and `"debugId"` into the map JSON without
//     a parse/stringify round-trip;
//   - moves the map out of `outDir` into a sibling `sourcemapDir` so
//     it ships in the npm tarball but stays out of APK assets / IPA
//     resources.
//
// `@sentry/bundler-plugin-core` is imported transitively via
// `@sentry/rollup-plugin` rather than as a direct devDep, so we always
// run on the exact version the rollup-plugin internally uses — that's
// the only way to guarantee the IDs match.

import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import path from "node:path";
import { isJsFile, stringToUUID } from "@sentry/bundler-plugin-core";

/**
 * @param {Map<string, string>} idMap
 * @returns {import('rolldown').Plugin}
 */
export function captureDebugIdsPlugin(idMap) {
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
 * @param {string} outDir
 * @param {string} sourcemapDir
 * @param {Map<string, string>} idMap
 * @returns {import('rolldown').Plugin}
 */
export function relocateSourcemapsPlugin(outDir, sourcemapDir, idMap) {
  return {
    name: "relocate-sourcemaps",
    async writeBundle() {
      rmSync(sourcemapDir, { force: true, recursive: true });
      await mkdir(sourcemapDir, { recursive: true });
      // Walk recursively so subdir entries (`lib/register.js`,
      // `chunks/*.mjs`) are relocated too — leaving them in `outDir`
      // would bloat the APK/IPA.
      const mapRelPaths = (await readdir(outDir, { recursive: true })).filter(
        (name) => name.endsWith(".map"),
      );
      await Promise.all(
        mapRelPaths.map(async (relPath) => {
          const bundleName = relPath.slice(0, -".map".length);
          const debugId = idMap.get(bundleName);
          const bundlePath = path.join(outDir, bundleName);
          const mapSrc = path.join(outDir, relPath);
          const mapDst = path.join(sourcemapDir, relPath);
          await mkdir(path.dirname(mapDst), { recursive: true });

          // Auto-emitted helper chunks (e.g. `_commonjsHelpers-*`)
          // bypass renderChunk so we have no debug ID. Relocate the
          // map as-is; sentry-cli matches them by filename.
          if (!debugId) {
            const mapSourceUntagged = await readFile(mapSrc, "utf8");
            await writeFile(mapDst, mapSourceUntagged, "utf8");
            await unlink(mapSrc);
            return;
          }

          const [bundleSource, mapSource] = await Promise.all([
            readFile(bundlePath, "utf8"),
            readFile(mapSrc, "utf8"),
          ]);

          // Sanity check: our captured ID should appear verbatim in the bundle
          // (inside `_sentryDebugIdIdentifier`). If not, sentry-rollup-plugin
          // either didn't run, ran in a different order, or hashed different
          // bytes. Catches plugin-order bugs and any future algorithmic
          // divergence between the two sides.
          if (!bundleSource.includes(debugId)) {
            throw new Error(
              `relocate-sourcemaps: captured debug ID ${debugId} not found ` +
                `in ${bundlePath}; @sentry/rollup-plugin may have changed ` +
                "its hashing algorithm or didn't run before this plugin.",
            );
          }

          // Spec-compliant trailing `//# debugId=` comment. Spec doesn't
          // constrain ordering with `//# sourceMappingURL=`; appending is safe.
          const patchedBundle = `${bundleSource}\n//# debugId=${debugId}\n`;

          // Splice `"debug_id"`+`"debugId"` into the map JSON before the
          // trailing `}`. Avoids a JSON.parse/stringify round-trip on a
          // multi-MB string. Both keys are written for back- compat: sentry-cli
          // <2.39 reads `debug_id` (snake_case), 2.39+ reads either, 3.0+
          // writes `debugId` only. Consumers' sentry-cli pin comes from their
          // @sentry/react-native version, so we can't assume 2.39+.
          const lastBrace = mapSource.lastIndexOf("}");
          if (lastBrace === -1) {
            throw new Error(
              `relocate-sourcemaps: ${mapSrc} does not look like JSON`,
            );
          }
          const inject = `,"debug_id":"${debugId}","debugId":"${debugId}"`;
          const patchedMap =
            mapSource.slice(0, lastBrace) + inject + mapSource.slice(lastBrace);

          await Promise.all([
            writeFile(bundlePath, patchedBundle, "utf8"),
            writeFile(mapDst, patchedMap, "utf8"),
          ]);
          await unlink(mapSrc);
        }),
      );
    },
  };
}
