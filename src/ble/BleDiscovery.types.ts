/**
 * Types shared between the BLE discovery manager, the native module
 * wrapper, and tests. Kept free of imports from the native wrapper so
 * tests can exercise `BleDiscovery` with a fake module without pulling
 * in `expo` / `requireNativeModule`.
 */

/** Mirrors expo-modules-core's `PermissionStatus`. */
export type BlePermissionStatus = "granted" | "denied" | "undetermined";

/**
 * Result of checking or requesting the Bluetooth permissions. Same
 * shape as expo's `PermissionResponse`. On Android 12+ this covers
 * `BLUETOOTH_SCAN` / `BLUETOOTH_ADVERTISE` / `BLUETOOTH_CONNECT`
 * (surfaced to the user as one "Nearby devices" dialog); on Android
 * 6–11 it covers `ACCESS_FINE_LOCATION`, which those versions require
 * for BLE scan results.
 */
export type BlePermissionResponse = {
  status: BlePermissionStatus;
  granted: boolean;
  canAskAgain: boolean;
  expires: "never" | number;
};

/** Best-effort adapter snapshot; both `false` when the platform has no
 * native BLE implementation (iOS today, web, tests). */
export type BleCapabilities = {
  /** A Bluetooth adapter exists on this device. */
  available: boolean;
  /** The adapter is currently switched on. */
  enabled: boolean;
};

/**
 * A raw sighting of a CoMapeo-filtered advertisement. `payload` is the
 * base64 manufacturer-data payload (company ID already stripped by the
 * platform); `address` is the sender's BLE MAC — randomized by modern
 * devices, so only useful for short-horizon dedup, not identity.
 */
export type BleAdvertisementPayload = {
  payload: string;
  rssi: number;
  address: string;
};

/** Async failure surfaced by the native side after a start succeeded
 * (e.g. the OS revoked advertising, scan registration failed). */
export type BleErrorPayload = {
  scope: "advertise" | "scan";
  code: string;
  message: string;
};

export type BleNativeEvents = {
  bleAdvertisement: (params: BleAdvertisementPayload) => void;
  bleError: (params: BleErrorPayload) => void;
};

/**
 * The surface `BleDiscovery` needs from the native module. Structural
 * subset of the real Expo `NativeModule` so tests can supply a plain
 * object.
 */
export interface BleNativeModuleLike {
  getCapabilities(): BleCapabilities;
  getPermissionsAsync(): Promise<BlePermissionResponse>;
  requestPermissionsAsync(): Promise<BlePermissionResponse>;
  /** Starts — or, when already advertising, atomically replaces — the
   * advertisement with the given base64 manufacturer-data payload. */
  startAdvertising(payloadBase64: string): Promise<void>;
  stopAdvertising(): Promise<void>;
  startScanning(): Promise<void>;
  stopScanning(): Promise<void>;
  addListener<EventName extends keyof BleNativeEvents>(
    eventName: EventName,
    listener: BleNativeEvents[EventName],
  ): unknown;
  removeListener<EventName extends keyof BleNativeEvents>(
    eventName: EventName,
    listener: BleNativeEvents[EventName],
  ): unknown;
}
