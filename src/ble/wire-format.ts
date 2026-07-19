/**
 * CoMapeo BLE advertisement wire format — v1 (Phase 1).
 *
 * This is the *manufacturer-specific-data payload*: the bytes that
 * follow the 2-byte company ID inside the manufacturer-data AD
 * structure. The platform APIs own everything outside it (flags AD,
 * AD header, company ID): Android's
 * `AdvertiseData.addManufacturerData(id, payload)` takes exactly this
 * payload, and `ScanRecord.getManufacturerSpecificData(id)` /
 * iOS `kCBAdvDataManufacturerData` (after stripping the leading
 * little-endian company ID) return it.
 *
 * Layout (all multi-byte fields big-endian):
 *
 * ```
 * offset len  field
 * 0      2    magic "CM" (0x43 0x4d)
 * 2      1    version (0x01)
 * 3      2    projectHash   — deriveDailyProjectHash()
 * 5      4    totalBlocks   — Hypercore blocks held (saturating)
 * 9      4    stateHash     — deriveStateHash()
 * 13     1    battery       — bit 7 charging, bits 6..0 percent
 *                             (0–100, 127 = unknown)
 * 14     1    flags         — bit 0 isHotspotLeader, bit 1 hasWifi,
 *                             bit 2 inviteMode, bits 3..7 reserved (0)
 * 15     4    ipv4          — device address on the sync-capable
 *                             interface (0.0.0.0 = none/unknown)
 * 19     2    port          — TCP port of the local peer-discovery
 *                             server (0 = not listening)
 * ─────────
 * 21 bytes
 * ```
 *
 * Budget check: 21 payload + 2 company ID + 2 AD header = 25, plus the
 * mandatory 3-byte flags AD = 28 of the 31-byte legacy advertisement.
 *
 * Two deliberate departures from the original design proposal (see
 * docs/ble-discovery.md):
 *  - a **version byte** after the magic, so future revisions are
 *    detectable instead of silently mis-parsed;
 *  - **ipv4 + port**, without which Phase 1's goal ("feed discovered
 *    IP:port into the existing connection pipeline") is unreachable —
 *    the proposal's layout carried sync state but no way to connect.
 */

/** Bluetooth SIG company identifier. 0xFFFF = reserved/testing value —
 * see design decision D8; the magic bytes disambiguate CoMapeo from
 * other 0xFFFF users. */
export const COMPANY_ID = 0xffff;

/** "CM" — the CoMapeo marker, first 2 payload bytes. Scan filters
 * match on these (hardware-offloaded on Android). */
export const MAGIC = Uint8Array.from([0x43, 0x4d]);

export const WIRE_FORMAT_VERSION = 0x01;

export const ADVERTISEMENT_PAYLOAD_LENGTH = 21;

/** Battery byte value meaning "unknown". */
const BATTERY_UNKNOWN = 0x7f;

export type CoMapeoAdvertisement = {
  /** Daily-rotated 16-bit project hash ({@link deriveDailyProjectHash}). */
  projectHash: number;
  /** Total Hypercore blocks held, saturating at 2^32 − 1. */
  totalBlocks: number;
  /** 32-bit sync-state hash ({@link deriveStateHash}). */
  stateHash: number;
  /** 0–100, or null when unknown. */
  batteryPercent: number | null;
  charging: boolean;
  isHotspotLeader: boolean;
  hasWifi: boolean;
  inviteMode: boolean;
  /** Dotted-quad IPv4 of the sync interface, or null when none. */
  address: string | null;
  /** TCP port of the local peer-discovery server, 0 when not listening. */
  port: number;
};

function assertUint(value: number, bits: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value >= 2 ** bits) {
    throw new RangeError(
      `${field} must be an integer in [0, 2^${bits}): got ${value}`,
    );
  }
}

function encodeIpv4(address: string): number {
  const parts = address.split(".");
  if (parts.length !== 4) {
    throw new RangeError(`address must be a dotted-quad IPv4: got ${address}`);
  }
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      throw new RangeError(
        `address must be a dotted-quad IPv4: got ${address}`,
      );
    }
    const octet = Number(part);
    if (octet > 255) {
      throw new RangeError(
        `address must be a dotted-quad IPv4: got ${address}`,
      );
    }
    out = out * 256 + octet;
  }
  return out;
}

function decodeIpv4(value: number): string | null {
  if (value === 0) return null;
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ].join(".");
}

/**
 * Encode an advertisement into the 21-byte manufacturer-data payload.
 * `totalBlocks` saturates at 2^32 − 1 (a count, not an identifier —
 * "very large" is all a peer needs to know); everything else
 * range-checks and throws, because an out-of-range hash or port is a
 * caller bug, not a value to clamp.
 */
export function encodeAdvertisement(ad: CoMapeoAdvertisement): Uint8Array {
  assertUint(ad.projectHash, 16, "projectHash");
  assertUint(ad.stateHash, 32, "stateHash");
  assertUint(ad.port, 16, "port");
  if (ad.batteryPercent !== null) {
    if (
      !Number.isInteger(ad.batteryPercent) ||
      ad.batteryPercent < 0 ||
      ad.batteryPercent > 100
    ) {
      throw new RangeError(
        `batteryPercent must be an integer in [0, 100] or null: got ${ad.batteryPercent}`,
      );
    }
  }
  if (!Number.isInteger(ad.totalBlocks) || ad.totalBlocks < 0) {
    throw new RangeError(
      `totalBlocks must be a non-negative integer: got ${ad.totalBlocks}`,
    );
  }
  const totalBlocks = Math.min(ad.totalBlocks, 0xffffffff);

  const out = new Uint8Array(ADVERTISEMENT_PAYLOAD_LENGTH);
  const view = new DataView(out.buffer);
  out.set(MAGIC, 0);
  out[2] = WIRE_FORMAT_VERSION;
  view.setUint16(3, ad.projectHash, false);
  view.setUint32(5, totalBlocks, false);
  view.setUint32(9, ad.stateHash, false);
  out[13] =
    (ad.charging ? 0x80 : 0) |
    (ad.batteryPercent === null ? BATTERY_UNKNOWN : ad.batteryPercent);
  out[14] =
    (ad.isHotspotLeader ? 0x01 : 0) |
    (ad.hasWifi ? 0x02 : 0) |
    (ad.inviteMode ? 0x04 : 0);
  view.setUint32(15, ad.address === null ? 0 : encodeIpv4(ad.address), false);
  view.setUint16(19, ad.port, false);
  return out;
}

/**
 * Decode a manufacturer-data payload. Returns `null` for anything that
 * isn't a CoMapeo v1 advertisement (wrong magic, unknown version,
 * wrong length) — other apps also use company ID 0xFFFF, so
 * non-CoMapeo payloads are expected, not errors. Trailing bytes beyond
 * the v1 length are rejected rather than ignored: v1 encoders never
 * produce them, so their presence means "not ours / corrupted".
 */
export function decodeAdvertisement(
  payload: Uint8Array,
): CoMapeoAdvertisement | null {
  if (payload.length !== ADVERTISEMENT_PAYLOAD_LENGTH) return null;
  const view = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  );
  if (view.getUint8(0) !== MAGIC[0] || view.getUint8(1) !== MAGIC[1]) {
    return null;
  }
  if (view.getUint8(2) !== WIRE_FORMAT_VERSION) return null;

  const batteryByte = view.getUint8(13);
  const batteryBits = batteryByte & 0x7f;
  const flags = view.getUint8(14);
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
    address: decodeIpv4(view.getUint32(15, false)),
    port: view.getUint16(19, false),
  };
}
