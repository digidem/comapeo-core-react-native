/**
 * The front-end surface of peer discovery (docs/ble-discovery.md §4/§6).
 *
 * There is deliberately no discovery-specific native module: the
 * backend's discovery controller owns the whole lifecycle (radios in
 * the Android FGS / iOS in-process engine, advertisement composition,
 * the auto-connect policy), and the front end reaches it through the
 * app-services RPC:
 *
 * ```ts
 * import { comapeo, comapeoServicesClient } from "@comapeo/core-react-native";
 *
 * await comapeoServicesClient.discovery.setEnabled(true);
 * comapeoServicesClient.on("discovery-state", (state) => render(state));
 *
 * // Connections need no wiring at all: the backend auto-connects
 * // same-project peers, and they surface through the manager as ever:
 * comapeo.on("local-peers", (peers) => renderConnected(peers));
 * ```
 *
 * Runtime permissions stay a host-app concern (they need an Activity):
 * request {@link ANDROID_BLE_PERMISSIONS} /
 * {@link ANDROID_BLE_LEGACY_PERMISSIONS} with React Native's
 * `PermissionsAndroid`; on iOS the system prompts on first use (the
 * Expo plugin injects `NSBluetoothAlwaysUsageDescription`). The
 * `blockers` field says when a prompt is actually needed.
 */

/** A nearby-but-not-necessarily-connected peer — from BLE sightings or
 * DNS-SD resolution. Pre-handshake BLE peers are anonymous by design
 * (the advertisement carries no identity); connected peers are the
 * separate, identified `local-peers` surface on the `comapeo` client. */
export type DiscoveredPeer = {
  source: "ble" | "mdns";
  /** `"<ip>:<port>"`, `"ble:<sender address>"`, or `"mdns:<name>"`. */
  id: string;
  /** Advertised daily project hash matches ours; null = unknown (mDNS
   * carries no sync-state gossip). */
  sameProject: boolean | null;
  /** Sync-state hashes differ — there is (probably) data to exchange;
   * null = unknown (mDNS). */
  hasDifferentSyncState: boolean | null;
  /** Latest raw RSSI in dBm; null for mDNS peers. */
  rssi: number | null;
  /** RSSI-cluster classification ("phones held together" UX). Always
   * false for mDNS peers. */
  inCluster: boolean;
  /** ms epoch (backend clock) of the last sighting/resolution. */
  lastSeenAt: number;
  address: string | null;
  port: number;
};

/** Radio state as reported by the platform engine. */
export type BleRadioState = {
  scanning: "active" | "stopped" | "unavailable";
  advertising: "active" | "stopped" | "unsupported" | "unavailable";
  /** Actionable causes — drive "Turn on Bluetooth" / permission UX. */
  blockers: ("bluetooth-off" | "permission-missing" | "no-adapter")[];
  /** Most recent radio error, for debug surfaces. */
  lastError: { scope: string; code: string; message: string } | null;
};

/** DNS-SD engine state (Android NsdManager / iOS Bonjour). */
export type NsdState = {
  browsing: "active" | "stopped" | "unavailable";
  registered: "active" | "stopped" | "unavailable";
  blockers: string[];
  lastError: { scope: string; code: string; message: string } | null;
};

export type DiscoveryState = {
  enabled: boolean;
  /** The project being advertised (null while disabled). */
  projectPublicId: string | null;
  ble: BleRadioState;
  nsd: NsdState;
  peers: DiscoveredPeer[];
};

/** The `discovery` namespace on `comapeoServicesClient`. */
export type DiscoveryApi = {
  getState(): Promise<DiscoveryState>;
  /**
   * Turn discovery on/off. On: starts core's local-peer server,
   * composes and broadcasts the advertisement, switches the radios on,
   * and persists the choice — an FGS/backend restart resumes without
   * the app's involvement. `projectPublicId` selects which project to
   * advertise; optional when the device has exactly one joined project.
   * Rejects before the backend reaches STARTED, and when the project
   * selection is ambiguous.
   */
  setEnabled(
    enabled: boolean,
    opts?: { projectPublicId?: string },
  ): Promise<void>;
};

/** Events the services client emits (server-side services emitter,
 * reflected by rpc-reflector). */
export type ComapeoServicesClientEvents = {
  /** Throttled `DiscoveryState` snapshots — peers seen/lost, radio
   * status changes, enable/disable. */
  "discovery-state": (state: DiscoveryState) => void;
};

/**
 * Android 12+ (API 31) runtime permissions for BLE discovery — request
 * via `PermissionsAndroid.requestMultiple`. All three surface as ONE
 * "Nearby devices" dialog; `BLUETOOTH_CONNECT` covers the GATT read
 * path that discovers iOS peers.
 */
export const ANDROID_BLE_PERMISSIONS = [
  "android.permission.BLUETOOTH_SCAN",
  "android.permission.BLUETOOTH_ADVERTISE",
  "android.permission.BLUETOOTH_CONNECT",
] as const;

/** Android 6–11 (API 23–30): those versions gate BLE scan results on
 * fine location. The install-time legacy Bluetooth permissions ship in
 * this library's manifest. */
export const ANDROID_BLE_LEGACY_PERMISSIONS = [
  "android.permission.ACCESS_FINE_LOCATION",
] as const;
