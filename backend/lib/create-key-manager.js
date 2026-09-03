// The backend's one KeyManager, split out of `index.js` so the
// cached-vs-fallback decision is unit-testable without sockets or a manager.
//
// The derive branch — and its `boot.master-key-derive` span — is the normal
// first boot after install: native has nothing cached, we derive, and the key
// goes back to native for the next boot (docs/master-key-cache-plan.md §4).
// Seeing the span on every boot of the same install is the degraded signal.

import { KeyManager } from "@comapeo/crypto";

/**
 * @param {object} options
 * @param {Buffer} options.rootKey 16-byte device identity from the init frame.
 * @param {Buffer} [options.masterKey] 32-byte master key native cached for {@link options.rootKey} on an earlier boot. Present → no derivation runs.
 * @param {<T>(name: string, fn: () => Promise<T>) => Promise<T>} options.withSpan
 * @param {typeof KeyManager} [options.keyManagerClass] Test seam.
 * @returns {Promise<KeyManager>}
 */
export async function createKeyManager({
  rootKey,
  masterKey,
  withSpan,
  keyManagerClass = KeyManager,
}) {
  if (masterKey) return new keyManagerClass(rootKey, { masterKey });
  return withSpan(
    "boot.master-key-derive",
    async () => new keyManagerClass(rootKey),
  );
}
