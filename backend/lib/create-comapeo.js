import path from "node:path";
import { MapeoManager } from "@comapeo/core";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";

const require = createRequire(import.meta.url);

const DEFAULT_CUSTOM_MAP_FILE_NAME = "default.smp";

/**
 * @param {Object} options
 * @param {string} options.privateStorageDir
 * @param {string} options.migrationsFolderPath
 * @param {Buffer} [options.rootKey]
 * @param {import('fastify').FastifyInstance} options.fastify
 */
export function createComapeo({
  privateStorageDir,
  migrationsFolderPath,
  rootKey = Buffer.from("488b706e61390df200df6018389a32bd", "hex"),
  fastify,
}) {
  // Do not touch these!
  const DB_DIR_NAME = "sqlite-dbs";
  const CORE_STORAGE_DIR_NAME = "core-storage";
  const CUSTOM_MAPS_DIR_NAME = "maps";

  const DEFAULT_ONLINE_MAP_STYLE_URL = `https://demotiles.maplibre.org/style.json`;

  const dbFolder = path.join(privateStorageDir, DB_DIR_NAME);
  const indexFolder = path.join(privateStorageDir, CORE_STORAGE_DIR_NAME);
  const customMapsDir = path.join(privateStorageDir, CUSTOM_MAPS_DIR_NAME);

  mkdirSync(dbFolder, { recursive: true });
  mkdirSync(indexFolder, { recursive: true });
  mkdirSync(customMapsDir, { recursive: true });

  // `__loadAddon` is injected at the top of the iOS rollup output by
  // `rollup-plugin-ios-addon-loader.js`. The plugin also rewrites this
  // single-arg call to inject the resolved version: at runtime the
  // arguments become ('better-sqlite3', '<resolved-version>'), keying
  // into the per-version xcframework at
  // NATIVE_LIB_DIR/<name>__<version>.framework/<name>__<version>.
  // On Android the helper isn't defined; this optional chain leaves
  // the option undefined and better-sqlite3 falls back to its default
  // node-bindings lookup against the .node extracted to
  // nodejs-project's node_modules tree.
  /** @type {object | undefined} */
  const betterSqlite3NativeBinding =
    /** @type {any} */ (globalThis).__loadAddon?.("better-sqlite3");

  return new MapeoManager({
    dbFolder,
    coreStorage: indexFolder,
    projectMigrationsFolder: path.join(migrationsFolderPath, "project"),
    clientMigrationsFolder: path.join(migrationsFolderPath, "client"),
    rootKey,
    fastify,
    defaultOnlineStyleUrl: DEFAULT_ONLINE_MAP_STYLE_URL,
    customMapPath: path.join(customMapsDir, DEFAULT_CUSTOM_MAP_FILE_NAME),
    betterSqlite3NativeBinding,
  });
}
