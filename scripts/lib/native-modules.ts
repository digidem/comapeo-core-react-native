import { readFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "execa";

export type NativeModule = { name: string; usesNapi: boolean };

/**
 * Native modules bundled into the nodejs-mobile backend. `usesNapi`
 * flips the prebuild URL between
 *   `<name>-<version>-node-<abi>-<platform>-<arch>.tar.gz`  (non-NAPI)
 *   `<name>-<version>-<platform>-<arch>.tar.gz`             (NAPI)
 */
export const NATIVE_MODULES: readonly NativeModule[] = [
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

/**
 * One distinct `(name, version)` pair to ship. The dep tree may carry
 * multiple disk locations of the same version (npm couldn't dedupe);
 * those collapse to one pair, since each (name, version) maps to one
 * prebuild artifact and one packaged native binary.
 */
export type NativePair = {
  name: string;
  version: string;
  usesNapi: boolean;
};

export async function collectNativePairs(
  backendDir: string,
  modules: readonly NativeModule[],
): Promise<NativePair[]> {
  const pairs: NativePair[] = [];

  for (const { name, usesNapi } of modules) {
    const npmListResult = await $({
      cwd: backendDir,
      lines: true,
    })`npm list ${name} --parseable`;

    const versions = new Set<string>();

    for (const modulePath of npmListResult.stdout) {
      const { version } = JSON.parse(
        readFileSync(join(modulePath, "package.json"), "utf-8"),
      );

      versions.add(version);
    }

    for (const version of versions.values()) {
      pairs.push({ name, version, usesNapi });
    }
  }

  return pairs;
}
