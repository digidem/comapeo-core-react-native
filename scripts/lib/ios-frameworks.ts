import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { cp } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "execa";

import type { NativePair } from "./native-modules.ts";
import { findNodeForArch } from "./prebuilds.ts";

const $$ = $({ stdio: "inherit" });

/**
 * Wrap each `(name, version)` instance into a multi-slice
 * `<name>__<version>.xcframework` under `frameworksDir`. Recipe lifted
 * from the validated harness in
 * `digidem/nodejs-mobile-bare-prebuilds@feat/jnilibs-xcframework-packaging`
 * (`assemble-test-project/action.yml#Wrap addons as xcframeworks`):
 *
 *   1. For each iOS arch, copy the .node binary as the framework's
 *      Mach-O exec inside <work>/<arch>/<key>.framework/<key>, rewrite
 *      its install name with `install_name_tool -id @rpath/...`, and
 *      write a minimal Info.plist next to it.
 *   2. lipo the two simulator binaries into one fat Mach-O so a single
 *      simulator slice covers both Apple Silicon and Intel hosts.
 *   3. xcodebuild -create-xcframework with the device framework and
 *      the lipo'd simulator framework → <frameworksDir>/<key>.xcframework.
 *
 * `xcodebuild`, `lipo`, and `install_name_tool` are macOS-only Xcode
 * command-line tools, so callers must gate on `process.platform`.
 */
export async function packageIosFrameworks({
  pairs,
  prebuildsDir,
  frameworksDir,
  workDir,
}: {
  pairs: NativePair[];
  prebuildsDir: string;
  frameworksDir: string;
  workDir: string;
}): Promise<void> {
  rmSync(frameworksDir, { force: true, recursive: true });
  mkdirSync(frameworksDir, { recursive: true });
  rmSync(workDir, { force: true, recursive: true });
  mkdirSync(workDir, { recursive: true });

  await Promise.all(
    pairs.map(async ({ name, version }) => {
      // Per-instance directory: `<name>__<version>` so two versions of
      // the same addon (e.g. sodium-native@4.3.3 + @5.1.0 in the
      // current dep tree) each get a distinct xcframework. Underscore-
      // separator instead of `@` because `@` in framework dir names
      // and Mach-O install names is unvalidated territory; double
      // underscore is filesystem-safe and unambiguous.
      const instanceKey = `${name}__${version}`;
      const moduleWorkDir = join(workDir, instanceKey);
      mkdirSync(moduleWorkDir, { recursive: true });

      const buildPerArchFramework = async (arch: string, srcNode: string) =>
        buildFramework({ instanceKey, moduleWorkDir, arch, srcNode });

      const [deviceNode, armSimNode, x64SimNode] = await Promise.all([
        findNodeForArch(prebuildsDir, name, version, "ios-arm64"),
        findNodeForArch(prebuildsDir, name, version, "ios-arm64-simulator"),
        findNodeForArch(prebuildsDir, name, version, "ios-x64-simulator"),
      ]);

      const deviceFramework = await buildPerArchFramework("arm64", deviceNode);
      const armSimFramework = await buildPerArchFramework(
        "arm64-simulator",
        armSimNode,
      );
      const x64SimFramework = await buildPerArchFramework(
        "x64-simulator",
        x64SimNode,
      );

      // lipo the two simulator slices into one fat Mach-O.
      const simFatDir = join(moduleWorkDir, "simulator");
      const simFatFramework = join(simFatDir, `${instanceKey}.framework`);
      mkdirSync(simFatFramework, { recursive: true });
      writeFileSync(
        join(simFatFramework, "Info.plist"),
        buildFrameworkPlist(instanceKey),
      );
      await $({
        stdio: "inherit",
      })`lipo -create ${join(armSimFramework, instanceKey)} ${join(x64SimFramework, instanceKey)} -output ${join(simFatFramework, instanceKey)}`;

      const xcframeworkPath = join(frameworksDir, `${instanceKey}.xcframework`);
      await $$`xcodebuild -create-xcframework -framework ${deviceFramework} -framework ${simFatFramework} -output ${xcframeworkPath}`;
    }),
  );

  rmSync(workDir, { force: true, recursive: true });
}

/**
 * Build one `<instanceKey>.framework/` directory for the given arch.
 * Returns the absolute path to the framework directory so it can be
 * fed into `lipo`/`xcodebuild` downstream.
 *
 * `install_name_tool -id` rewrites the Mach-O's `LC_ID_DYLIB` from the
 * upstream prebuild's `<name>.node` (a name dyld cannot resolve inside
 * `<App>.app/Frameworks/`) to `@rpath/<instanceKey>.framework/<instanceKey>`.
 * Without this, `LC_LOAD_DYLIB` self-references in the same binary
 * cause an "image not found" abort at app launch — Embed & Sign + the
 * regular dyld load command walk hits the original install name
 * *before* our runtime `process.dlopen` ever runs. The validated
 * harness skipped this because its test apps `dlopen` directly without
 * embedding the framework into a fully-linked .app bundle.
 */
async function buildFramework({
  instanceKey,
  moduleWorkDir,
  arch,
  srcNode,
}: {
  instanceKey: string;
  moduleWorkDir: string;
  arch: string;
  srcNode: string;
}): Promise<string> {
  const archDir = join(moduleWorkDir, arch);
  const frameworkDir = join(archDir, `${instanceKey}.framework`);
  mkdirSync(frameworkDir, { recursive: true });
  // Mach-O exec name matches the framework dir name so the runtime
  // helper's `process.dlopen('<NATIVE_LIB_DIR>/<instanceKey>.framework/<instanceKey>')`
  // resolves uniformly across addons — even better-sqlite3, whose
  // .node tarball ships as `better_sqlite3.node` (underscore).
  const dstBinary = join(frameworkDir, instanceKey);
  await cp(srcNode, dstBinary);
  await $({
    stdio: "inherit",
  })`install_name_tool -id @rpath/${instanceKey}.framework/${instanceKey} ${dstBinary}`;
  writeFileSync(
    join(frameworkDir, "Info.plist"),
    buildFrameworkPlist(instanceKey),
  );
  return frameworkDir;
}

/**
 * Minimal Info.plist for a synthetic iOS framework wrapping a single
 * `.node` Mach-O. Mirrors the harness recipe verbatim — Apple's loader
 * + codesign require these specific keys; trimming further breaks
 * Embed & Sign at app build time.
 */
function buildFrameworkPlist(name: string): string {
  // CFBundleIdentifier accepts only [A-Za-z0-9.-] per Apple's spec —
  // underscores are rejected at app codesign time. Our `instanceKey`
  // form `<name>__<version>` puts a `__` in there, so the bundle ID
  // gets a sanitised variant: `__` collapses to a single `-`. The
  // result is still unique per (name, version) because the version's
  // dots stay (`sodium-native__5.1.0` → `com.comapeo.core.frameworks.sodium-native-5.1.0`).
  const bundleId = `com.comapeo.core.frameworks.${name.replace(/__/g, "-")}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>${name}</string>
  <key>CFBundleIdentifier</key><string>${bundleId}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>${name}</string>
  <key>CFBundlePackageType</key><string>FMWK</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleSignature</key><string>????</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>MinimumOSVersion</key><string>15.1</string>
</dict></plist>
`;
}
