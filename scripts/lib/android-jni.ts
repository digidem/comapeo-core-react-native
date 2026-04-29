import { mkdirSync, rmSync } from "node:fs";
import { cp } from "node:fs/promises";
import { join } from "node:path";

import type { NativePair } from "./native-modules.ts";
import { ANDROID_ARCHS, findNodeForArch } from "./prebuilds.ts";

/**
 * Package each `(name, version)` instance as
 * `jniLibs/<abi>/lib<name>__<version>.so`. Bionic's per-app linker
 * namespace mmaps these from the APK at load time when the manifest
 * sets `extractNativeLibs="false"` and AGP keeps them uncompressed via
 * `useLegacyPackaging=false`. The runtime helper
 * (`androidAddonLoaderBanner` from rollup-plugin-addon-loader.js) does
 * `process.dlopen('lib<name>__<version>.so')` — bare filename, no
 * path — and Bionic resolves against the APK's `lib/<abi>/` segment.
 *
 * Phase 1 wrote `.node` files into `assets/nodejs-native/<abi>/...`
 * for runtime extraction; that path is gone. The bundled JS (still
 * extracted from `assets/nodejs-project/`) loads addons via the
 * `__loadAddon` rewrite at the same versioned key.
 */
export async function packageAndroidJniLibs({
  pairs,
  prebuildsDir,
  jniLibsDir,
}: {
  pairs: NativePair[];
  prebuildsDir: string;
  jniLibsDir: string;
}): Promise<void> {
  rmSync(jniLibsDir, { force: true, recursive: true });

  await Promise.all(
    ANDROID_ARCHS.map(async (arch) => {
      const abiDir = join(jniLibsDir, androidAbiForArch(arch));
      mkdirSync(abiDir, { recursive: true });

      for (const { name, version } of pairs) {
        const srcNode = await findNodeForArch(
          prebuildsDir,
          name,
          version,
          `android-${arch}`,
        );
        const dst = join(abiDir, `lib${name}__${version}.so`);
        await cp(srcNode, dst, { force: true });
      }
    }),
  );
}

/**
 * Map our internal Android arch tags (the ones in the prebuild
 * tarball's `android-<arch>` suffix) to AGP's ABI directory names
 * used in `jniLibs/<abi>/`.
 */
function androidAbiForArch(arch: (typeof ANDROID_ARCHS)[number]): string {
  switch (arch) {
    case "arm":
      return "armeabi-v7a";
    case "arm64":
      return "arm64-v8a";
    case "x64":
      return "x86_64";
  }
}
