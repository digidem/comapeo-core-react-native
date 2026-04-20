import path from "node:path";
import { MapeoManager } from "@comapeo/core";
import { createRequire } from "node:module";
import Fastify from "fastify";

const require = createRequire(import.meta.url);

const coreFolder = path.dirname(require.resolve("@comapeo/core/package.json"));
const clientMigrationsFolder = path.join(coreFolder, "drizzle/client");
const projectMigrationsFolder = path.join(coreFolder, "drizzle/project");

/**
 * @param {Object} options
 * @param {string} options.privateStorageDir
 * @param {Buffer} [options.rootKey]
 * @param {import('fastify').FastifyInstance} options.fastify
 */
export function createComapeo({
  privateStorageDir,
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

  return new MapeoManager({
    dbFolder,
    coreStorage: indexFolder,
    projectMigrationsFolder,
    clientMigrationsFolder,
    rootKey,
    fastify,
    defaultOnlineStyleUrl: DEFAULT_ONLINE_MAP_STYLE_URL,
  });
}
