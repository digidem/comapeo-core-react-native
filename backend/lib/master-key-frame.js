// Encoding of the outbound `master-key` control frame — the derived master
// key on its way back to native's cache. Split out of `index.js` so the
// encoding can be pinned against `parse-init.js`'s inbound validator without
// booting the backend.

import { Buffer } from "node:buffer";

const MASTER_KEY_BYTE_LENGTH = 32;

/**
 * @param {Buffer} masterKey
 * @returns {{ type: "master-key", masterKey: string }}
 */
export function masterKeyFrame(masterKey) {
  if (
    !Buffer.isBuffer(masterKey) ||
    masterKey.length !== MASTER_KEY_BYTE_LENGTH
  ) {
    throw new Error(
      `masterKey must be a ${MASTER_KEY_BYTE_LENGTH}-byte Buffer, got ` +
        `${Buffer.isBuffer(masterKey) ? `${masterKey.length} bytes` : typeof masterKey}`,
    );
  }
  return { type: "master-key", masterKey: masterKey.toString("base64") };
}
