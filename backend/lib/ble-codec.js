import { createHash, createHmac } from "node:crypto";

/**
 * The CoMapeo BLE v1 advertisement codec + hash derivations — the
 * normative implementation (byte layout: docs/ble-discovery.md §3).
 * The backend both composes and decodes advertisements; native code
 * treats payloads as opaque bytes. The Kotlin/Swift engines only know
 * the company ID + "CM" prefix (scan filtering) and the GATT service /
 * characteristic UUIDs below.
 */

export const ADVERTISEMENT_PAYLOAD_LENGTH = 21;

/**
 * GATT identifiers for the iOS discoverability path: iOS cannot put
 * manufacturer data in an advertisement, so it advertises SERVICE_UUID
 * and serves the same 21-byte payload as the value of the sync-state
 * characteristic. Mirrored in `BleProtocol.kt` / `BleDiscoveryEngine.swift`.
 */
export const BLE_SERVICE_UUID = "c3992d3b-af17-484c-ab89-24ae377279d4";
export const BLE_SYNC_STATE_CHARACTERISTIC_UUID =
  "1e2909d4-767b-4635-affe-97f936b91a48";

const MAGIC_0 = 0x43; // "C"
const MAGIC_1 = 0x4d; // "M"
const WIRE_FORMAT_VERSION = 0x01;
const BATTERY_UNKNOWN = 0x7f;

/** Domain-separation prefix for every CoMapeo BLE hash derivation. */
const DOMAIN_PREFIX = "comapeo-ble-v1:";

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
 * Encode an advertisement into the 21-byte payload. `totalBlocks`
 * saturates at 2^32 − 1; other out-of-range fields throw (caller bug).
 *
 * @param {BleAdvertisement} ad
 * @returns {Buffer}
 */
export function encodeAdvertisement(ad) {
  assertUint(ad.projectHash, 16, "projectHash");
  assertUint(ad.stateHash, 32, "stateHash");
  assertUint(ad.port, 16, "port");
  const out = Buffer.alloc(ADVERTISEMENT_PAYLOAD_LENGTH);
  out[0] = MAGIC_0;
  out[1] = MAGIC_1;
  out[2] = WIRE_FORMAT_VERSION;
  out.writeUInt16BE(ad.projectHash, 3);
  out.writeUInt32BE(Math.min(Math.max(0, Math.floor(ad.totalBlocks)), 0xffffffff), 5);
  out.writeUInt32BE(ad.stateHash, 9);
  out[13] =
    (ad.charging ? 0x80 : 0) |
    (ad.batteryPercent === null ? BATTERY_UNKNOWN : clampBattery(ad.batteryPercent));
  out[14] =
    (ad.isHotspotLeader ? 0x01 : 0) |
    (ad.hasWifi ? 0x02 : 0) |
    (ad.inviteMode ? 0x04 : 0);
  out.writeUInt32BE(ad.address === null ? 0 : encodeIpv4(ad.address), 15);
  out.writeUInt16BE(ad.port, 19);
  return out;
}

/**
 * @param {number} value
 * @param {number} bits
 * @param {string} field
 */
function assertUint(value, bits, field) {
  if (!Number.isInteger(value) || value < 0 || value >= 2 ** bits) {
    throw new RangeError(`${field} must be an integer in [0, 2^${bits}): got ${value}`);
  }
}

/** @param {number} percent */
function clampBattery(percent) {
  return Math.min(100, Math.max(0, Math.floor(percent)));
}

/** @param {string} address */
function encodeIpv4(address) {
  const parts = address.split(".");
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) {
    throw new RangeError(`address must be a dotted-quad IPv4: got ${address}`);
  }
  return parts.reduce((acc, p) => acc * 256 + Number(p), 0);
}

/**
 * Daily-rotated 16-bit project hash:
 * `HMAC-SHA256(secret, "comapeo-ble-v1:project:" + UTC day)[0..2]`.
 * Phase 1 uses the project *public* ID (a one-way blake2b of the
 * project key) as the secret: every member knows it, a passive BLE
 * observer does not. See docs/ble-discovery.md §3.
 *
 * @param {Buffer | Uint8Array} secret
 * @param {Date} now
 * @returns {number}
 */
export function deriveDailyProjectHash(secret, now) {
  const day =
    `${now.getUTCFullYear()}-` +
    `${String(now.getUTCMonth() + 1).padStart(2, "0")}-` +
    `${String(now.getUTCDate()).padStart(2, "0")}`;
  const mac = createHmac("sha256", secret)
    .update(`${DOMAIN_PREFIX}project:${day}`)
    .digest();
  return mac.readUInt16BE(0);
}

/**
 * 32-bit sync-state hash: first 4 bytes of
 * `SHA-256("comapeo-ble-v1:state:" || stateBytes)`. Equal ⇒ (within
 * 2^-32) same content; different ⇒ connect and reconcile.
 *
 * @param {Buffer | Uint8Array | string} stateBytes
 * @returns {number}
 */
export function deriveStateHash(stateBytes) {
  return createHash("sha256")
    .update(`${DOMAIN_PREFIX}state:`)
    .update(stateBytes)
    .digest()
    .readUInt32BE(0);
}

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
