import { mkdirSync, rmSync, unlinkSync } from "node:fs";
import { glob } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "execa";

import type { NativePair } from "./native-modules.ts";

/** target = `${platform}-${arch}` (e.g. "android-arm64", "ios-arm64-simulator") */
type PrebuildTarget = { platform: "android" | "ios"; arch: string };

export const ANDROID_ARCHS = ["arm", "arm64", "x64"] as const;
// Phase 2: device + both simulator slices. xcframework packaging combines
// them into one multi-slice artifact per addon — Xcode picks the right
// slice at app build time based on the build destination.
export const IOS_ARCHS = ["arm64", "arm64-simulator", "x64-simulator"] as const;

const PREBUILD_TARGETS: PrebuildTarget[] = [
  ...ANDROID_ARCHS.map((arch) => ({ platform: "android" as const, arch })),
  ...IOS_ARCHS.map((arch) => ({ platform: "ios" as const, arch })),
];

/**
 * Download every (pair × target) prebuild tarball into
 * `<destDir>/<name>__<version>/<target>/` and unpack it. Re-creates
 * `destDir` from scratch so a stale entry from a previous run can't
 * leak through.
 */
export async function downloadPrebuilds(
  pairs: NativePair[],
  nodeAbi: string | undefined,
  destDir: string,
): Promise<void> {
  rmSync(destDir, { recursive: true, force: true });
  await Promise.all(
    pairs.map(async ({ name, version, usesNapi }) => {
      const instanceDir = join(destDir, `${name}__${version}`);
      await Promise.all(
        PREBUILD_TARGETS.map(async ({ platform, arch }) => {
          const targetDir = join(instanceDir, `${platform}-${arch}`);
          mkdirSync(targetDir, { recursive: true });

          const artifact = getArtifactInfo({
            name,
            version,
            platform,
            arch,
            nodeAbi: usesNapi ? undefined : nodeAbi,
          });

          // `--retry 5 --retry-all-errors --retry-delay 2`: GitHub's
          // releases CDN occasionally serves transient 5xx responses;
          // one 502 was enough to fail an entire CI run on this PR.
          // `--retry-all-errors` makes 5xx retryable — by default curl
          // only retries network-level failures.
          await $({
            cwd: targetDir,
          })`curl --fail --location --retry 5 --retry-all-errors --retry-delay 2 ${artifact.url} --output ${artifact.name}`;

          await $({
            cwd: targetDir,
          })`tar xzf ${artifact.name} --directory .`;

          unlinkSync(join(targetDir, artifact.name));
        }),
      );
    }),
  );
}

/**
 * Locate the single `.node` file inside the per-instance prebuild tree
 * for the given target (e.g. `ios-arm64`, `android-arm64`). Bare-style
 * addons ship at `<key>/<target>/<name>.node`; better-sqlite3 ships at
 * `<key>/<target>/better_sqlite3.node` (underscore). Throws if zero or
 * more than one matches — either means the prebuild tarball changed
 * shape upstream.
 */
export async function findNodeForArch(
  prebuildsDir: string,
  name: string,
  version: string,
  target: string,
): Promise<string> {
  const archDir = join(prebuildsDir, `${name}__${version}`, target);
  const matches = await Array.fromAsync(glob(`**/*.node`, { cwd: archDir }));
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one .node file for ${name}__${version} on ${target}; found ${matches.length}: ${matches.join(", ")}`,
    );
  }
  return join(archDir, matches[0]!);
}

function getArtifactInfo({
  name,
  version,
  platform,
  arch,
  nodeAbi,
}: {
  name: string;
  version: string;
  platform: "android" | "ios";
  arch: string;
  nodeAbi?: string;
}) {
  const assetName = nodeAbi
    ? `${name}-${version}-node-${nodeAbi}-${platform}-${arch}.tar.gz`
    : `${name}-${version}-${platform}-${arch}.tar.gz`;

  return {
    name: assetName,
    url: `https://github.com/digidem/${name}-nodejs-mobile/releases/download/${version}/${assetName}`,
  };
}
