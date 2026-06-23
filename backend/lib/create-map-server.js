import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createServer } from "@comapeo/map-server";
import { KeyManager } from "@mapeo/crypto";

import { DEFAULT_ONLINE_MAP_STYLE_URL } from "./default-online-style-url.js";

const require = createRequire(import.meta.url);

const DEFAULT_FALLBACK_MAP_FILE_PATH = require.resolve("@comapeo/fallback-smp");
const DEFAULT_CUSTOM_MAP_FILE_NAME = "default.smp";
const CUSTOM_MAPS_DIR_NAME = "maps";

/**
 *
 * @param {Object} options
 * @param {string} options.privateStorageDir
 * @param {Buffer} options.rootKey 16-byte device identity supplied by native code.
 * @param {string} [options.defaultOnlineStyleUrl] Online map style URL the consuming app sets via the Expo plugin. Undefined → falls back to {@link DEFAULT_ONLINE_MAP_STYLE_URL}.
 */
export function createMapServer({
  privateStorageDir,
  rootKey,
  defaultOnlineStyleUrl,
}) {
  const customMapsDir = join(privateStorageDir, CUSTOM_MAPS_DIR_NAME);

  mkdirSync(customMapsDir, { recursive: true });

  const { publicKey, secretKey } = new KeyManager(rootKey).getIdentityKeypair();

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
