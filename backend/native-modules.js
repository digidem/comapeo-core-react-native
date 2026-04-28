/**
 * Native modules bundled into the nodejs-mobile backend. Shared by:
 *   - backend/rollup.config.js (copies each module's package.json +
 *     binding.gyp into the bundled output so Bare's addon resolver has
 *     the metadata it expects at runtime)
 *   - scripts/build-backend.ts (downloads prebuilds and packages them
 *     into Android jniLibs / iOS xcframeworks)
 *
 * `usesNapi` flips the prebuild URL between
 *   `<name>-<version>-node-<abi>-<platform>-<arch>.tar.gz`  (non-NAPI)
 *   `<name>-<version>-<platform>-<arch>.tar.gz`             (NAPI)
 *
 * @type {Array<{ name: string, usesNapi: boolean }>}
 */
export const NATIVE_MODULES = [
  { name: "better-sqlite3", usesNapi: false },
  // Native module seems may cause issues on some devices. If so, exclude from list to use JS version.
  // https://github.com/digidem/comapeo-mobile/issues/1096
  { name: "crc-native", usesNapi: true },
  { name: "fs-native-extensions", usesNapi: true },
  { name: "quickbit-native", usesNapi: true },
  { name: "rabin-native", usesNapi: true },
  { name: "simdle-native", usesNapi: true },
  { name: "sodium-native", usesNapi: true },
];
