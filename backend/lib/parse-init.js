// Validation of the control-socket `init` payload, split out of
// `index.js` so the matrix is unit-testable without sockets.
//
// The two keys have deliberately different failure modes: `rootKey` is the
// device identity, so a malformed one is fatal (the caller rejects the init
// promise and the process exits); `masterKey` is a native-side cache of an
// expensive derivation, so a malformed one degrades to re-deriving from the
// rootkey — loud, but never a boot failure. See
// docs/master-key-cache-plan.md §3.1.
//
// Nothing here may put key material in a message: these strings reach the
// logs and Sentry.

/**
 * @typedef {{ reason: "type" | "encoding" | "trailing-bits", message: string }} MasterKeyWarning
 */

/**
 * @typedef {{ ok: true, rootKey: Buffer, masterKey?: Buffer, masterKeyWarning?: MasterKeyWarning }} InitOk
 */

/** @typedef {{ ok: false, error: Error }} InitFailure */

/** @typedef {InitOk | InitFailure} InitResult */

/**
 * @param {Record<string, unknown>} message
 * @returns {InitResult}
 */
export function parseInit(message) {
  if (typeof message.rootKey !== "string") {
    return {
      ok: false,
      error: new Error(
        `init.rootKey must be a base64 string, got ${typeof message.rootKey}`,
      ),
    };
  }
  // `Buffer.from(s, "base64")` silently drops invalid chars, so a
  // tampered string can still decode to 16 unrelated bytes. Both
  // platforms emit standard base64; 16 bytes = 22 chars + "==".
  if (!/^[A-Za-z0-9+/]{22}==$/.test(message.rootKey)) {
    return {
      ok: false,
      error: new Error(
        `init.rootKey is not strict-base64 of 16 bytes (expected ` +
          `/^[A-Za-z0-9+/]{22}==$/, got ${message.rootKey.length} chars)`,
      ),
    };
  }
  const rootKey = Buffer.from(message.rootKey, "base64");
  // The length is already guaranteed by the regex, but the last character
  // carries 4 bits the 16 bytes don't use; a decoder ignores them, so two
  // different strings can decode to the same key. Re-encoding and comparing
  // rejects the ones native could not have produced.
  if (rootKey.toString("base64") !== message.rootKey) {
    return {
      ok: false,
      error: new Error(
        "init.rootKey does not survive a base64 decode/encode round trip " +
          "(unused trailing bits are set)",
      ),
    };
  }

  if (message.masterKey === undefined) return { ok: true, rootKey };

  if (typeof message.masterKey !== "string") {
    return {
      ok: true,
      rootKey,
      masterKeyWarning: {
        reason: "type",
        message:
          `init.masterKey must be a base64 string, got ` +
          `${typeof message.masterKey}; ignoring it and re-deriving`,
      },
    };
  }
  // 32 bytes = 43 chars + "=", strict-base64 for the same reason as above.
  if (!/^[A-Za-z0-9+/]{43}=$/.test(message.masterKey)) {
    return {
      ok: true,
      rootKey,
      masterKeyWarning: {
        reason: "encoding",
        message:
          `init.masterKey is not strict-base64 of 32 bytes (expected ` +
          `/^[A-Za-z0-9+/]{43}=$/, got ${message.masterKey.length} chars); ` +
          `ignoring it and re-deriving`,
      },
    };
  }
  const masterKey = Buffer.from(message.masterKey, "base64");
  // Same round trip as the rootkey above (2 unused trailing bits here).
  if (masterKey.toString("base64") !== message.masterKey) {
    return {
      ok: true,
      rootKey,
      masterKeyWarning: {
        reason: "trailing-bits",
        message:
          "init.masterKey does not survive a base64 decode/encode round trip " +
          "(unused trailing bits are set); ignoring it and re-deriving",
      },
    };
  }

  return { ok: true, rootKey, masterKey };
}
