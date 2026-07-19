package com.comapeo.core.ble

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat

/**
 * The runtime permissions BLE discovery needs, by SDK level. Split out
 * (and parameterised on `sdkInt`) so the mapping is JVM-unit-testable.
 *
 * - API 31+ — the "Nearby devices" runtime group: `BLUETOOTH_SCAN`
 *   (declared `neverForLocation` in the manifest, so no location
 *   permission is involved), `BLUETOOTH_ADVERTISE`, and
 *   `BLUETOOTH_CONNECT` (not needed for Phase 1's advertise/scan, but
 *   requested now so the Phase-1.5 GATT client/server work doesn't
 *   re-prompt users — all three surface as ONE system dialog).
 * - API 23–30 — `ACCESS_FINE_LOCATION`, which those versions require
 *   for BLE scan results to be delivered. The legacy `BLUETOOTH` /
 *   `BLUETOOTH_ADMIN` permissions are install-time (manifest-only).
 */
object BlePermissions {
    fun required(sdkInt: Int): Array<String> =
        if (sdkInt >= Build.VERSION_CODES.S) {
            arrayOf(
                Manifest.permission.BLUETOOTH_SCAN,
                Manifest.permission.BLUETOOTH_ADVERTISE,
                Manifest.permission.BLUETOOTH_CONNECT,
            )
        } else {
            arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
        }

    /**
     * Whether this app currently satisfies a prerequisite for the
     * `connectedDevice` foreground-service type (enforced from API 34:
     * `startForeground` with that type throws SecurityException unless
     * a qualifying runtime state holds — for us, any granted
     * Nearby-devices permission). Below API 31 the legacy `BLUETOOTH`
     * permission is install-time, so it qualifies whenever declared.
     */
    fun hasConnectedDeviceFgsPrerequisite(context: Context): Boolean {
        val candidates = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            arrayOf(
                Manifest.permission.BLUETOOTH_CONNECT,
                Manifest.permission.BLUETOOTH_SCAN,
                Manifest.permission.BLUETOOTH_ADVERTISE,
            )
        } else {
            arrayOf(Manifest.permission.BLUETOOTH)
        }
        return candidates.any {
            ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED
        }
    }
}
