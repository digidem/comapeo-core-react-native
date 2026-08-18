import path from "node:path";
import { MapeoManager } from "@comapeo/core";
import { MapeoManager as FallbackMapeoManager } from "comapeo-core-old";
import { mkdirSync } from "node:fs";

import { DEFAULT_ONLINE_MAP_STYLE_URL } from "./default-online-style-url.js";

const DEFAULT_CUSTOM_MAP_FILE_NAME = "default.smp";

/**
 * @param {Object} options
 * @param {string} options.privateStorageDir
 * @param {string} options.migrationsFolderPath Path to current drizzle migrations (new version).
 * @param {string} options.oldMigrationsFolderPath Path to drizzle migrations from the fallback version.
 * @param {string} [options.defaultConfigPath] Optional default project config (presets/categories) the consuming app bundles. Undefined → new projects get no default config.
 * @param {string} [options.defaultOnlineStyleUrl] Online map style URL the consuming app sets via the Expo plugin. Undefined → falls back to {@link DEFAULT_ONLINE_MAP_STYLE_URL}.
 * @param {Buffer} options.rootKey 16-byte device identity supplied by native code.
 * @param {import('fastify').FastifyInstance} options.fastify
 * @param {boolean} [options.useFallback] When true, instantiate the old MapeoManager version instead of the current one.
 */
export function createComapeo({
  privateStorageDir,
  migrationsFolderPath,
  oldMigrationsFolderPath,
  defaultConfigPath,
  defaultOnlineStyleUrl,
  rootKey,
  fastify,
  useFallback = false,
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

  const ManagerClass = useFallback ? FallbackMapeoManager : MapeoManager;
  const migrationPath = useFallback
    ? oldMigrationsFolderPath
    : migrationsFolderPath;

  return new ManagerClass({
    dbFolder,
    coreStorage: indexFolder,
    projectMigrationsFolder: path.join(migrationPath, "project"),
    clientMigrationsFolder: path.join(migrationPath, "client"),
    rootKey,
    fastify,
    defaultConfigPath,
    defaultOnlineStyleUrl: defaultOnlineStyleUrl || DEFAULT_ONLINE_MAP_STYLE_URL,
    customMapPath: path.join(customMapsDir, DEFAULT_CUSTOM_MAP_FILE_NAME),
  });
}
