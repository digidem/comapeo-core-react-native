/**
 * Seed old-format hypercore storage for migration tests.
 *
 * Creates projects with observations using the old MapeoManager version
 * (`comapeo-core-old`), producing on-disk storage that triggers the
 * migration path in `checkShouldMigrate`.
 *
 * Uses `@mapeo/mock-data` to generate valid observation documents,
 * matching the pattern in `@comapeo/core/test-e2e/migration.js`.
 *
 * @module
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import Fastify from "fastify";
import { generate } from "@mapeo/mock-data";
import { MapeoManager as OldMapeoManager } from "comapeo-core-old";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OLD_DRIZZLE = join(__dirname, "..", "node_modules", "comapeo-core-old", "drizzle");

/**
 * Returns a new object with the own enumerable keys of `obj` that are not in `keys`.
 *
 * In other words, remove some keys from an object.
 *
 * @template {object} T
 * @template {keyof T} K
 * @param {T} obj
 * @param {ReadonlyArray<K>} keys
 * @returns {Omit<T, K>}
 * @example
 * const obj = { foo: 1, bar: 2, baz: 3 }
 * omit(obj, ['foo', 'bar'])
 * // => { baz: 3 }
 */
export function omit(obj, keys) {
  /** @type {Partial<T>} */ const result = {}

  /** @type {Set<unknown>} */ const toOmit = new Set(keys)

  for (const key in obj) {
    if (!Object.hasOwn(obj, key)) continue
    if (toOmit.has(key)) continue
    result[key] = obj[key]
  }

  return /** @type {Omit<T, K>} */ (result)
}

/**
 * @template {import('@comapeo/schema').MapeoDoc & { forks?: string[], createdBy?: string, updatedBy?: string}} T
 * @param {T} doc
 * @returns {Omit<T, 'docId' | 'versionId' | 'originalVersionId' | 'links' | 'forks' | 'deleted' | 'createdAt' | 'updatedAt' | 'createdBy' | 'updatedBy'>}
 */
export function valueOf(doc) {
  return omit(doc, [
    'docId',
    'versionId',
    'originalVersionId',
    'links',
    'forks',
    'createdAt',
    'updatedAt',
    'createdBy',
    'updatedBy',
    'deleted',
  ])
}

/**
 * Create old-format storage with one project and some observations.
 *
 * @param {string} privateStorageDir The app's private storage root.
 * @param {string} rootKeyBase64 Base64-encoded 16-byte rootkey.
 */
export async function seedOldStorage(privateStorageDir, rootKeyBase64) {
  const rootKey = Buffer.from(rootKeyBase64, "base64");
  const dbFolder = join(privateStorageDir, "db");
  const coreStorage = join(privateStorageDir, "core-storage");
  mkdirSync(dbFolder, { recursive: true });
  mkdirSync(coreStorage, { recursive: true });

  const fastify = Fastify();

  const manager = new OldMapeoManager({
    rootKey,
    dbFolder,
    projectMigrationsFolder: join(OLD_DRIZZLE, "project"),
    clientMigrationsFolder: join(OLD_DRIZZLE, "client"),
    coreStorage,
    fastify,
  });

  const projectId = await manager.createProject({ name: "migration-test" });
  const project = await manager.getProject(projectId);

  // Create observations using mock data (same pattern as comapeo-core e2e tests)
  for (let i = 0; i < 5; i++) {
    const mockObs = valueOf(generate("observation")[0]);
    const { docId } = await project.observation.create(mockObs);
    await project.observation.getByDocId(docId);
  }

  await project.close();
  await fastify.close();
}
