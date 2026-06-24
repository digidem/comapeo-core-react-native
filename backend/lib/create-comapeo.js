import path from "node:path";
import { MapeoManager } from "@comapeo/core";
import { mkdirSync } from "node:fs";

import { DEFAULT_ONLINE_MAP_STYLE_URL } from "./default-online-style-url.js";

const DEFAULT_CUSTOM_MAP_FILE_NAME = "default.smp";

/**
 * @param {Object} options
 * @param {string} options.privateStorageDir
 * @param {string} options.migrationsFolderPath
 * @param {string} [options.defaultConfigPath] Optional default project config (presets/categories) the consuming app bundles. Undefined → new projects get no default config.
 * @param {string} [options.defaultOnlineStyleUrl] Online map style URL the consuming app sets via the Expo plugin. Undefined → falls back to {@link DEFAULT_ONLINE_MAP_STYLE_URL}.
 * @param {Buffer} options.rootKey 16-byte device identity supplied by native code.
 * @param {import('fastify').FastifyInstance} options.fastify
 */
export function createComapeo({
  privateStorageDir,
  migrationsFolderPath,
  defaultConfigPath,
  defaultOnlineStyleUrl,
  rootKey,
  fastify,
}) {
  if (!Buffer.isBuffer(rootKey) || rootKey.byteLength !== 16) {
    throw new Error(
      `createComapeo: rootKey must be a 16-byte Buffer, got ${
        Buffer.isBuffer(rootKey) ? `${rootKey.byteLength} bytes` : typeof rootKey
      }`,
    );
  }
  // Renaming these breaks existing on-device data — leave as-is.
  const DB_DIR_NAME = "sqlite-dbs";
  const CORE_STORAGE_DIR_NAME = "core-storage";
  const CUSTOM_MAPS_DIR_NAME = "maps";

  const dbFolder = path.join(privateStorageDir, DB_DIR_NAME);
  const indexFolder = path.join(privateStorageDir, CORE_STORAGE_DIR_NAME);
  const customMapsDir = path.join(privateStorageDir, CUSTOM_MAPS_DIR_NAME);

  mkdirSync(dbFolder, { recursive: true });
  mkdirSync(indexFolder, { recursive: true });
  mkdirSync(customMapsDir, { recursive: true });

  return new MapeoManager({
    dbFolder,
    coreStorage: indexFolder,
    projectMigrationsFolder: path.join(migrationsFolderPath, "project"),
    clientMigrationsFolder: path.join(migrationsFolderPath, "client"),
    rootKey,
    fastify,
    defaultConfigPath,
    defaultOnlineStyleUrl: defaultOnlineStyleUrl || DEFAULT_ONLINE_MAP_STYLE_URL,
    customMapPath: path.join(customMapsDir, DEFAULT_CUSTOM_MAP_FILE_NAME),
  });
}
