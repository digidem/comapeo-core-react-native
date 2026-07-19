/**
 * `@comapeo/core-react-native/ble` — Phase 1 BLE peer discovery.
 *
 * See docs/ble-discovery.md for the design (and its critical review of
 * the original proposal). In brief: Android devices advertise a 21-byte
 * manufacturer-data payload carrying sync state + IP:port; everyone
 * scans (hardware-filtered); the host app connects discovered peers via
 * the existing `comapeo.connectLocalPeer` RPC. This sub-export is
 * side-effect-free on platforms without the native module — check
 * `bleDiscovery.isAvailable`.
 */
import { BleDiscovery } from "./BleDiscovery";
import { loadBleNativeModule } from "./ComapeoBleModule";

export {
  COMPANY_ID,
  MAGIC,
  WIRE_FORMAT_VERSION,
  ADVERTISEMENT_PAYLOAD_LENGTH,
  encodeAdvertisement,
  decodeAdvertisement,
  type CoMapeoAdvertisement,
} from "./wire-format";
export {
  sha256,
  hmacSha256,
  deriveDailyProjectHash,
  deriveStateHash,
  deriveSsidHash,
} from "./hashes";
export { bytesToBase64, base64ToBytes } from "./base64";
export {
  BleDiscovery,
  BleDiscoveryError,
  type BleDiscoveryEvents,
  type BleDiscoveryOptions,
  type BlePeer,
} from "./BleDiscovery";
export type {
  BleAdvertisementPayload,
  BleCapabilities,
  BleErrorPayload,
  BleNativeEvents,
  BleNativeModuleLike,
  BlePermissionResponse,
  BlePermissionStatus,
} from "./BleDiscovery.types";

/**
 * Shared discovery singleton wired to the native module (null-backed —
 * every method a safe no-op/rejection — on platforms without one).
 * Mirrors the `comapeo` / `state` singleton pattern of the main entry.
 */
export const bleDiscovery = new BleDiscovery(loadBleNativeModule());
