import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { NATIVE_MODULES } from "../../backend/native-modules.js";

export { NATIVE_MODULES };

export type NativeModule = { name: string; usesNapi: boolean };

/**
 * One concrete on-disk install of a native module. Multiple `Instance`
 * entries can share the same `(name, version)` pair — the dep tree
 * commonly carries several nested copies of the same version that npm
 * couldn't dedupe.
 */
export type NativeModuleInstance = {
  name: string;
  version: string;
  /** Absolute path to the package directory (where `package.json` lives). */
  packageDir: string;
  /** True iff this is the hoisted top-level install at `node_modules/<name>/`. */
  isTopLevel: boolean;
};

/**
 * One distinct `(name, version)` pair to ship. Carries `usesNapi`
 * forward for prebuild-URL resolution.
 */
export type NativePair = NativeModuleInstance & { usesNapi: boolean };

/**
 * Walk `<backendDir>/node_modules` for every installed instance of
 * `name` (top-level + every nested copy). Used to enumerate the full
 * set of `(name, version)` pairs we need to ship — multi-version dep
 * trees ship one artifact per pair, not one per name (which would
 * silently shadow the lower version with the higher one).
 */
export function findNativeModuleInstances(
  backendDir: string,
  name: string,
): NativeModuleInstance[] {
  const topLevelNodeModules = join(backendDir, "node_modules");
  const instances: NativeModuleInstance[] = [];
  const seen = new Set<string>();
  const stack: string[] = [topLevelNodeModules];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    const candidate = join(dir, name, "package.json");
    if (existsSync(candidate)) {
      const packageDir = dirname(candidate);
      if (!seen.has(packageDir)) {
        seen.add(packageDir);
        const { version } = JSON.parse(readFileSync(candidate, "utf-8"));
        instances.push({
          name,
          version,
          packageDir,
          isTopLevel: dir === topLevelNodeModules,
        });
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
  return instances;
}

/**
 * Resolve every `(name, version)` pair that needs a prebuild +
 * platform packaging. Multiple disk locations can share the same
 * version (e.g. four nested `sodium-native@5.1.0` copies); the
 * addon-loader rewrite loads each one by its versioned key, so build-
 * side dedup avoids racing four parallel fetches into the same temp
 * dir.
 */
export function collectNativePairs(
  backendDir: string,
  modules: readonly NativeModule[],
): NativePair[] {
  const allInstances = modules.flatMap(({ name, usesNapi }) =>
    findNativeModuleInstances(backendDir, name).map((inst) => ({
      ...inst,
      usesNapi,
    })),
  );
  const seen = new Map<string, NativePair>();
  for (const inst of allInstances) {
    const key = `${inst.name}__${inst.version}`;
    if (!seen.has(key)) seen.set(key, inst);
  }
  return [...seen.values()];
}
