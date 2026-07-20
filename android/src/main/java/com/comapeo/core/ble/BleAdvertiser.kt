package com.comapeo.core.ble

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeAdvertiser
import android.content.Context

/**
 * Legacy (31-byte) BLE advertising of one manufacturer-data structure
 * under company ID 0xFFFF. `start` with a new payload atomically
 * replaces the running advertisement (stop + start — the Android API
 * has no in-place update below API 26's advertising sets, and the
 * sub-second gap is invisible to scanners that dedupe on address).
 *
 * Deliberate choices (see docs/ble-discovery.md):
 * - `ADVERTISE_MODE_BALANCED` (~250 ms interval): discovery within a
 *   couple of scan windows without the battery cost of low-latency.
 *   Battery validation on target devices is an open question (Q9).
 * - `ADVERTISE_TX_POWER_HIGH`: room-scale range on budget hardware;
 *   the RSSI cluster thresholds in the JS layer assume this setting.
 * - Not connectable — Phase 1 has no GATT server yet; a
 *   non-connectable advertisement costs no connection slot and can't
 *   be probed.
 * - No device name / TX-power fields — every spare byte belongs to the
 *   payload.
 */
class BleAdvertiser(private val onError: (code: String, message: String) -> Unit) {
    private var advertiser: BluetoothLeAdvertiser? = null
    private var callback: AdvertiseCallback? = null

    val isAdvertising: Boolean
        get() = callback != null

    /**
     * Permission enforcement is explicit: callers hold
     * BLUETOOTH_ADVERTISE (API 31+) or the legacy install-time grants,
     * checked via the SecurityException catch below rather than a
     * lint-visible annotation.
     */
    @SuppressLint("MissingPermission")
    fun start(context: Context, payload: ByteArray) {
        val adapter = bluetoothAdapter(context)
            ?: throw BleException("ERR_BLE_UNAVAILABLE", "No Bluetooth adapter on this device")
        stop()
        val leAdvertiser = adapter.bluetoothLeAdvertiser
            ?: throw if (!isEnabledSafe(adapter)) {
                BleException("ERR_BLE_DISABLED", "Bluetooth is turned off")
            } else {
                BleException(
                    "ERR_BLE_ADVERTISE_UNSUPPORTED",
                    "This device's Bluetooth stack does not support LE advertising",
                )
            }

        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_BALANCED)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
            .setConnectable(false)
            .setTimeout(0)
            .build()
        val data = AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .setIncludeTxPowerLevel(false)
            .addManufacturerData(BleProtocol.COMPANY_ID, payload)
            .build()
        val cb = object : AdvertiseCallback() {
            override fun onStartFailure(errorCode: Int) {
                // Async failure path — the start() call already returned.
                // Identity guard: `applyAdvertisement` does stop()+start()
                // to replace an advertisement, so a late failure from the
                // PREVIOUS callback must not null out the CURRENT one (which
                // would leave a live advertisement `stop()` can no longer
                // reach). AdvertiseCallback fires on the main looper, same as
                // the engine's handler, so this compares safely.
                if (callback !== this) return
                callback = null
                advertiser = null
                onError("ERR_BLE_ADVERTISE", describeAdvertiseError(errorCode))
            }
        }
        try {
            leAdvertiser.startAdvertising(settings, data, cb)
        } catch (e: SecurityException) {
            throw BleException(
                "ERR_BLE_PERMISSION",
                "Missing Bluetooth advertise permission: ${e.message}",
            )
        }
        advertiser = leAdvertiser
        callback = cb
    }

    @SuppressLint("MissingPermission")
    fun stop() {
        val cb = callback ?: return
        callback = null
        try {
            advertiser?.stopAdvertising(cb)
        } catch (_: SecurityException) {
            // Permission revoked mid-session; the OS already killed the
            // advertisement, nothing to clean up.
        }
        advertiser = null
    }

    private fun describeAdvertiseError(errorCode: Int): String = when (errorCode) {
        AdvertiseCallback.ADVERTISE_FAILED_DATA_TOO_LARGE ->
            "Advertisement payload too large for this device"
        AdvertiseCallback.ADVERTISE_FAILED_TOO_MANY_ADVERTISERS ->
            "No advertising slot available (too many concurrent advertisers)"
        AdvertiseCallback.ADVERTISE_FAILED_ALREADY_STARTED ->
            "Advertising already started"
        AdvertiseCallback.ADVERTISE_FAILED_INTERNAL_ERROR ->
            "Internal Bluetooth stack error"
        AdvertiseCallback.ADVERTISE_FAILED_FEATURE_UNSUPPORTED ->
            "LE advertising not supported on this device"
        else -> "Advertising failed (code $errorCode)"
    }

    companion object {
        fun bluetoothAdapter(context: Context): BluetoothAdapter? =
            (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

        /**
         * `isEnabled` is annotated as needing BLUETOOTH_CONNECT on some
         * API 31+ builds; treat a SecurityException as "unknown → off"
         * rather than crashing a capability probe.
         */
        @SuppressLint("MissingPermission")
        fun isEnabledSafe(adapter: BluetoothAdapter): Boolean = try {
            adapter.isEnabled
        } catch (_: SecurityException) {
            false
        }
    }
}
