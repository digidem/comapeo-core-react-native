import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Reads the nodejs-mobile version + ABI from the libnode header that
 * `npm run download:nodejs-mobile` lays down. The Node ABI is the only
 * field we currently consume — non-NAPI prebuilds (better-sqlite3
 * today) bake the ABI into their tarball name, so the asset URL
 * changes when nodejs-mobile bumps Node.
 */
export function readNodeJsMobileVersions() {
  const nodeVersionFilePath = fileURLToPath(
    new URL(
      "../../android/libnode/include/node/node_version.h",
      import.meta.url,
    ),
  );

  const content = readFileSync(nodeVersionFilePath, "utf-8");

  const major = content.match(/#define NODE_MAJOR_VERSION (.+)/)?.[1];
  const minor = content.match(/#define NODE_MINOR_VERSION (.+)/)?.[1];
  const patch = content.match(/#define NODE_PATCH_VERSION (.+)/)?.[1];
  const abi = content.match(/#define NODE_MODULE_VERSION (.+)/)?.[1];

  return { major, minor, patch, abi };
}
