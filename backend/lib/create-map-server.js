import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createServer } from "@comapeo/map-server";

import { DEFAULT_ONLINE_MAP_STYLE_URL } from "./default-online-style-url.js";

const require = createRequire(import.meta.url);

const DEFAULT_FALLBACK_MAP_FILE_PATH = require.resolve("@comapeo/fallback-smp");
const DEFAULT_CUSTOM_MAP_FILE_NAME = "default.smp";
const CUSTOM_MAPS_DIR_NAME = "maps";

/**
 *
 * @param {Object} options
 * @param {string} options.privateStorageDir
 * @param {{ publicKey: Buffer, secretKey: Buffer }} options.identityKeypair Device identity keypair from the backend's shared `KeyManager` — taking the derived keypair rather than the rootkey keeps the expensive master-key derivation to one per boot.
 * @param {string} [options.defaultOnlineStyleUrl] Online map style URL the consuming app sets via the Expo plugin. Undefined → falls back to {@link DEFAULT_ONLINE_MAP_STYLE_URL}.
 */
export function createMapServer({
  privateStorageDir,
  identityKeypair,
  defaultOnlineStyleUrl,
}) {
  const { publicKey, secretKey } = identityKeypair ?? {};
  assertKeyPart("publicKey", publicKey, 32);
  assertKeyPart("secretKey", secretKey, 64);

  const customMapsDir = join(privateStorageDir, CUSTOM_MAPS_DIR_NAME);

  mkdirSync(customMapsDir, { recursive: true });

  const mapServer = createServer({
    defaultOnlineStyleUrl: defaultOnlineStyleUrl || DEFAULT_ONLINE_MAP_STYLE_URL,
    fallbackMapPath: DEFAULT_FALLBACK_MAP_FILE_PATH,
    customMapPath: join(customMapsDir, DEFAULT_CUSTOM_MAP_FILE_NAME),
    keyPair: {
      publicKey: new Uint8Array(publicKey),
      secretKey: new Uint8Array(secretKey),
    },
  });

  return mapServer;
}

/**
 * @param {string} name
 * @param {unknown} value
 * @param {number} byteLength
 */
function assertKeyPart(name, value, byteLength) {
  if (!Buffer.isBuffer(value) || value.byteLength !== byteLength) {
    throw new Error(
      `createMapServer: identityKeypair.${name} must be a ${byteLength}-byte Buffer, got ${
        Buffer.isBuffer(value) ? `${value.byteLength} bytes` : typeof value
      }`,
    );
  }
}
