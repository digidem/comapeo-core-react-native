import { NativeModule, requireNativeModule } from "expo";
import type {
  BleCapabilities,
  BleNativeEvents,
  BlePermissionResponse,
} from "./BleDiscovery.types";

/**
 * The `ComapeoBleDiscovery` native module surface. Android-only for
 * now: Phase 1 ships the Android advertiser + scanner (see
 * docs/ble-discovery.md); the iOS scanner and the cross-platform GATT
 * server come later, so on iOS this module intentionally fails to
 * resolve and `loadBleNativeModule()` returns null.
 */
declare class ComapeoBleDiscoveryModule extends NativeModule<BleNativeEvents> {
  getCapabilities(): BleCapabilities;
  getPermissionsAsync(): Promise<BlePermissionResponse>;
  requestPermissionsAsync(): Promise<BlePermissionResponse>;
  startDiscovery(payloadBase64: string | null): Promise<void>;
  updateAdvertisement(payloadBase64: string | null): Promise<void>;
  stopDiscovery(): Promise<void>;
}

/**
 * Resolve the native module, or null where it doesn't exist (iOS, web,
 * Jest). Unlike `ComapeoCore` — which is load-bearing and should crash
 * loudly when missing — BLE discovery is an optional capability the
 * host feature-detects via `bleDiscovery.isAvailable`.
 */
export function loadBleNativeModule(): ComapeoBleDiscoveryModule | null {
  try {
    return requireNativeModule<ComapeoBleDiscoveryModule>(
      "ComapeoBleDiscovery",
    );
  } catch {
    return null;
  }
}
