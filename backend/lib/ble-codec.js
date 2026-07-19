/**
 * Decoder for the CoMapeo BLE v1 advertisement payload.
 *
 * Mirror of the RN-side codec in `src/ble/wire-format.ts`, which is the
 * normative implementation (see docs/ble-discovery.md §3 for the byte
 * layout). The backend only ever *decodes* — advertisement composition
 * stays on the RN side — so no encoder is ported. The two
 * implementations are kept honest by a shared hex vector asserted in
 * both test suites (`src/__tests__/ble-wire-format.test.js` and
 * `lib/ble-codec.test.mjs`).
 */

export const ADVERTISEMENT_PAYLOAD_LENGTH = 21;

const MAGIC_0 = 0x43; // "C"
const MAGIC_1 = 0x4d; // "M"
const WIRE_FORMAT_VERSION = 0x01;
const BATTERY_UNKNOWN = 0x7f;

/**
 * @typedef {object} BleAdvertisement
 * @property {number} projectHash 16-bit daily-rotated project hash
 * @property {number} totalBlocks
 * @property {number} stateHash 32-bit sync-state hash
 * @property {number | null} batteryPercent 0–100, null when unknown
 * @property {boolean} charging
 * @property {boolean} isHotspotLeader
 * @property {boolean} hasWifi
 * @property {boolean} inviteMode
 * @property {string | null} address dotted-quad IPv4, null when none
 * @property {number} port 0 when not listening
 */

/**
 * Decode a manufacturer-data payload. Returns `null` for anything that
 * isn't a CoMapeo v1 advertisement (wrong magic/version/length) —
 * other apps share company ID 0xFFFF, so that's expected, not an error.
 *
 * @param {Uint8Array} payload
 * @returns {BleAdvertisement | null}
 */
export function decodeAdvertisement(payload) {
  if (payload.length !== ADVERTISEMENT_PAYLOAD_LENGTH) return null;
  if (payload[0] !== MAGIC_0 || payload[1] !== MAGIC_1) return null;
  if (payload[2] !== WIRE_FORMAT_VERSION) return null;

  const view = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  );
  const batteryByte = view.getUint8(13);
  const batteryBits = batteryByte & 0x7f;
  const flags = view.getUint8(14);
  const ipv4 = view.getUint32(15, false);
  return {
    projectHash: view.getUint16(3, false),
    totalBlocks: view.getUint32(5, false),
    stateHash: view.getUint32(9, false),
    batteryPercent:
      batteryBits === BATTERY_UNKNOWN ? null : Math.min(batteryBits, 100),
    charging: (batteryByte & 0x80) !== 0,
    isHotspotLeader: (flags & 0x01) !== 0,
    hasWifi: (flags & 0x02) !== 0,
    inviteMode: (flags & 0x04) !== 0,
    address:
      ipv4 === 0
        ? null
        : [
            (ipv4 >>> 24) & 0xff,
            (ipv4 >>> 16) & 0xff,
            (ipv4 >>> 8) & 0xff,
            ipv4 & 0xff,
          ].join("."),
    port: view.getUint16(19, false),
  };
}
