import { Buffer } from "node:buffer";

/**
 * Validate an `init` control frame's `rootKey`. Pure: no I/O, no
 * promise side effects — the caller decides whether a returned error
 * rejects `initPromise` or is otherwise surfaced.
 *
 * `Buffer.from(s, "base64")` silently drops invalid chars, so a tampered
 * string can still decode to 16 unrelated bytes. Both platforms emit
 * standard base64; 16 bytes = 22 chars + "==".
 *
 * @param {Record<string, unknown>} message
 * @returns {{ rootKey: Buffer, error?: undefined } | { rootKey?: undefined, error: Error }}
 */
export function validateInit(message) {
  if (typeof message.rootKey !== "string") {
    return {
      error: new Error(
        `init.rootKey must be a base64 string, got ${typeof message.rootKey}`,
      ),
    };
  }
  if (!/^[A-Za-z0-9+/]{22}==$/.test(message.rootKey)) {
    return {
      error: new Error(
        `init.rootKey is not strict-base64 of 16 bytes (expected ` +
          `/^[A-Za-z0-9+/]{22}==$/, got ${message.rootKey.length} chars)`,
      ),
    };
  }
  const rootKey = Buffer.from(message.rootKey, "base64");
  if (rootKey.byteLength !== 16) {
    return {
      error: new Error(
        `init.rootKey must decode to 16 bytes, got ${rootKey.byteLength}`,
      ),
    };
  }
  return { rootKey };
}
