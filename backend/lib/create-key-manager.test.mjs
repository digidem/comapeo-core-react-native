import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

import { createKeyManager } from "./create-key-manager.js";

/**
 * These pin the point of the whole cache: the cached path must construct the
 * KeyManager with the supplied master key (so no Argon2id runs) and must not
 * open the `boot.master-key-derive` span, and the derive path — the first
 * boot after install — must derive exactly once.
 *
 * "Derives" is read off the constructor call: a KeyManager built without the
 * `masterKey` option runs the derivation, one built with it does not — that
 * equivalence is asserted against the real class in create-comapeo.test.mjs.
 */

const ROOT_KEY = Buffer.alloc(16, 3);
const MASTER_KEY = Buffer.alloc(32, 4);

function spies() {
  /** @type {Array<{ rootKey: unknown, masterKey: unknown }>} */
  const constructed = [];
  /** @type {string[]} */
  const spans = [];
  class FakeKeyManager {
    /**
     * @param {unknown} rootKey
     * @param {{ masterKey?: unknown }} [opts]
     */
    constructor(rootKey, opts = {}) {
      constructed.push({ rootKey, masterKey: opts.masterKey });
    }
  }
  /**
   * @template T
   * @param {string} name
   * @param {() => Promise<T>} fn
   */
  const withSpan = (name, fn) => {
    spans.push(name);
    return fn();
  };
  return {
    constructed,
    spans,
    keyManagerClass: /** @type {any} */ (FakeKeyManager),
    withSpan,
  };
}

test("a cached master key is used as-is, with no derivation span", async () => {
  const { constructed, spans, keyManagerClass, withSpan } = spies();

  await createKeyManager({
    rootKey: ROOT_KEY,
    masterKey: MASTER_KEY,
    withSpan,
    keyManagerClass,
  });

  assert.deepEqual(spans, []);
  assert.equal(constructed.length, 1);
  assert.equal(constructed[0].rootKey, ROOT_KEY);
  assert.equal(constructed[0].masterKey, MASTER_KEY);
});

test("without a cached master key the fallback derives exactly once", async () => {
  const { constructed, spans, keyManagerClass, withSpan } = spies();

  await createKeyManager({ rootKey: ROOT_KEY, withSpan, keyManagerClass });

  assert.deepEqual(spans, ["boot.master-key-derive"]);
  assert.equal(constructed.length, 1);
  assert.equal(constructed[0].masterKey, undefined);
});

test("returns the constructed KeyManager", async () => {
  const { keyManagerClass, withSpan } = spies();
  const keyManager = await createKeyManager({
    rootKey: ROOT_KEY,
    masterKey: MASTER_KEY,
    withSpan,
    keyManagerClass,
  });
  assert.ok(keyManager instanceof keyManagerClass);
});
