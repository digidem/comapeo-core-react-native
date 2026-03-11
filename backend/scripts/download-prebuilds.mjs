#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { fileURLToPath } from "node:url";
import tarStream from "tar-stream";

const require = createRequire(import.meta.url);

const ROOT_DIR_URL = new URL("../", import.meta.url);
const PREBUILD_DIR_URL = new URL("./dist/prebuilds/", ROOT_DIR_URL);
const NATIVE_ADDON_EXTENSIONS = [".node", ".dll", ".so"];
const NATIVE_ADDON_IGNORE = ["./test_extension.node"]; // better-sqlite3 releases include this
fs.rmSync(PREBUILD_DIR_URL, { recursive: true, force: true });

// TODO: Figure out how to know if module uses N-API at runtime
const NATIVE_MODULES = [
  { name: "better-sqlite3", usesNapi: false },
  // { name: "crc-native", usesNapi: true },
  { name: "fs-native-extensions", usesNapi: true },
  { name: "quickbit-native", usesNapi: true },
  { name: "simdle-native", usesNapi: true },
  { name: "sodium-native", usesNapi: true },
];

const TARGETS = ["android-arm", "android-arm64", "android-x64"];

for (const mod of NATIVE_MODULES) {
  for (const target of TARGETS) {
    const destDirUrl = new URL(`${mod.name}/${target}/`, PREBUILD_DIR_URL);
    fs.mkdirSync(destDirUrl, { recursive: true });
    downloadPrebuild({
      moduleName: mod.name,
      usesNapi: mod.usesNapi,
      destDirUrl,
      target,
    });
  }
}

/**
 * @param {object} opts
 * @param {string} opts.moduleName
 * @param {boolean} opts.usesNapi
 * @param {URL} opts.destDirUrl
 * @param {string} opts.target
 */
async function downloadPrebuild({ moduleName, usesNapi, destDirUrl, target }) {
  const version = getModuleVersion(moduleName);
  const { abi } = getNodeJsMobileNodeVersions();
  const url = getArtifactUrl({
    name: moduleName,
    version,
    target,
    nodeAbi: usesNapi ? undefined : abi,
  });
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(
      `Failed to download prebuild for ${moduleName}@${version} (${target}): ${response.status} ${response.statusText}`
    );
  }
  let pipelinePromise;
  let destUrl;
  const bodyReadable = Readable.fromWeb(
    /** @type {import("stream/web").ReadableStream<Uint8Array<ArrayBuffer>>} */ (
      response.body
    )
  );
  const extract = tarStream.extract();
  bodyReadable.pipe(createGunzip()).pipe(extract);
  for await (const entry of extract) {
    const { name: entryPath, type } = entry.header;
    const { base: fileName, ext } = path.parse(entryPath);
    const entryIsNativeAddon = NATIVE_ADDON_EXTENSIONS.includes(ext);
    const entryIsIgnored = NATIVE_ADDON_IGNORE.includes(entryPath);
    if (type !== "file" || !entryIsNativeAddon || entryIsIgnored) {
      entry.resume();
      continue;
    }
    destUrl = new URL(fileName, destDirUrl);
    pipelinePromise = pipeline(entry, fs.createWriteStream(destUrl));
  }
  if (!pipelinePromise || !destUrl) {
    throw new Error(
      `No prebuild artifact found in download for ${moduleName}@${version} (${target})`
    );
  }
  await pipelinePromise;
  console.log(
    `Downloaded prebuild ${path.relative(fileURLToPath(ROOT_DIR_URL), fileURLToPath(destUrl))}`
  );
}

/**
 * @param {string} moduleName
 */
function getModuleVersion(moduleName) {
  const pkgJsonPath = require.resolve(`${moduleName}/package.json`);
  const { version } = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
  return version;
}

/**
 * @param {{name: string, version: string, target: string, nodeAbi?: string}} opts
 * @returns {URL}
 */
function getArtifactUrl({ name, version, target, nodeAbi }) {
  const assetName = nodeAbi
    ? `${name}-${version}-node-${nodeAbi}-${target}.tar.gz`
    : `${name}-${version}-${target}.tar.gz`;

  return new URL(
    `https://github.com/digidem/${name}-nodejs-mobile/releases/download/${version}/${assetName}`
  );
}

function getNodeJsMobileNodeVersions() {
  const nodeVersionFilePath = new URL(
    "../../android/libnode/include/node/node_version.h",
    import.meta.url
  ).pathname;

  const content = fs.readFileSync(nodeVersionFilePath, "utf-8");

  const major = content.match(/#define NODE_MAJOR_VERSION (.+)/)?.[1];
  const minor = content.match(/#define NODE_MINOR_VERSION (.+)/)?.[1];
  const patch = content.match(/#define NODE_PATCH_VERSION (.+)/)?.[1];
  const abi = content.match(/#define NODE_MODULE_VERSION (.+)/)?.[1];

  if (!major || !minor || !patch || !abi) {
    throw new Error("Could not determine Node.js version from source");
  }

  return {
    major,
    minor,
    patch,
    abi,
  };
}
