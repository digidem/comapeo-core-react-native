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
 * A sighting of a CoMapeo-filtered advertisement, relayed from the
 * FGS-hosted scanner via the backend's `ble-peer` broadcast. `payload`
 * is the base64 manufacturer-data payload (company ID already stripped
 * by the platform); `address` is the sender's BLE MAC — randomized by
 * modern devices, so only useful for short-horizon dedup, not identity.
 */
export type BleAdvertisementPayload = {
  payload: string;
  rssi: number;
  address: string;
};

/**
 * Radio failure from the FGS-hosted engine (relayed via the backend).
 * Discovery is intent-driven, so ALL radio errors — including ones a
 * start call provokes, like Bluetooth being off — arrive on this
 * channel, never as a rejection of `start()`.
 */
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
 *
 * The discovery methods are asynchronous *controls*, not radio calls:
 * the native module forwards them to the `:ComapeoCore` foreground
 * service (where the radios live, so discovery survives backgrounding)
 * and retains the desired state, re-pushing it if the service
 * restarts. They resolve on dispatch and reject only on invalid input
 * or a missing native context — radio failures come back as `bleError`
 * events.
 */
export interface BleNativeModuleLike {
  getCapabilities(): BleCapabilities;
  getPermissionsAsync(): Promise<BlePermissionResponse>;
  requestPermissionsAsync(): Promise<BlePermissionResponse>;
  /** Start scanning; `payloadBase64` non-null also starts (or replaces)
   * the advertisement. */
  startDiscovery(payloadBase64: string | null): Promise<void>;
  /** Replace (or with null clear) the advertisement; scan untouched. */
  updateAdvertisement(payloadBase64: string | null): Promise<void>;
  stopDiscovery(): Promise<void>;
  addListener<EventName extends keyof BleNativeEvents>(
    eventName: EventName,
    listener: BleNativeEvents[EventName],
  ): unknown;
  removeListener<EventName extends keyof BleNativeEvents>(
    eventName: EventName,
    listener: BleNativeEvents[EventName],
  ): unknown;
}
