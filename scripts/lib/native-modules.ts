import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

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

/**
 * Walk `<backendDir>/node_modules` for every installed `(name,
 * version)` of `name` (top-level + every nested copy). Multi-version
 * dep trees ship one artifact per `(name, version)` pair, not one per
 * name (which would silently shadow the lower version with the higher
 * one).
 */
function findNativeModuleVersions(
  backendDir: string,
  name: string,
): { version: string }[] {
  const topLevelNodeModules = join(backendDir, "node_modules");
  const versions: { version: string }[] = [];
  const seenDirs = new Set<string>();
  const stack: string[] = [topLevelNodeModules];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    const candidate = join(dir, name, "package.json");
    if (existsSync(candidate)) {
      const packageDir = dirname(candidate);
      if (!seenDirs.has(packageDir)) {
        seenDirs.add(packageDir);
        const { version } = JSON.parse(readFileSync(candidate, "utf-8"));
        versions.push({ version });
      }
    }
    const entries = (() => {
      try {
        return readdirSync(dir, { withFileTypes: true });
      } catch {
        return [];
      }
    })();
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const nested = join(dir, entry.name, "node_modules");
      if (existsSync(nested)) stack.push(nested);
    }
  }
  return versions;
}

/**
 * Resolve every `(name, version)` pair that needs a prebuild +
 * platform packaging. Multiple disk locations can share the same
 * version (e.g. four nested `sodium-native@5.1.0` copies); the
 * addon-loader rewrite loads each one by its versioned key, so build-
 * side dedup avoids racing parallel fetches into the same temp dir.
 */
export function collectNativePairs(
  backendDir: string,
  modules: readonly NativeModule[],
): NativePair[] {
  const seen = new Map<string, NativePair>();
  for (const { name, usesNapi } of modules) {
    for (const { version } of findNativeModuleVersions(backendDir, name)) {
      const key = `${name}__${version}`;
      if (!seen.has(key)) seen.set(key, { name, version, usesNapi });
    }
  }
  return [...seen.values()];
}
