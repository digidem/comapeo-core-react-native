package com.comapeo.core.ble

import android.annotation.SuppressLint
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context

/**
 * Hardware-filtered scan for CoMapeo advertisements: the controller
 * offloads a match on company ID 0xFFFF with the first two payload
 * bytes equal to "CM", so non-CoMapeo traffic never wakes the main CPU
 * and the scan keeps working with the screen off (design decision D1).
 * Full payload validation (version, length, field parsing) happens in
 * the JS decoder — a "CM"-prefixed foreign payload gets dropped there.
 *
 * `SCAN_MODE_BALANCED` trades a few seconds of worst-case discovery
 * latency for a duty cycle that can run continuously; repeated
 * sightings (CALLBACK_TYPE_ALL_MATCHES, no report delay) are the
 * feature, not noise — they carry the RSSI stream the JS clustering
 * smooths, and payload changes (sync-state updates) arrive as new
 * sightings.
 */
class BleScanner(
    private val onSighting: (payload: ByteArray, rssi: Int, address: String) -> Unit,
    private val onError: (code: String, message: String) -> Unit,
) {
    private var scanner: BluetoothLeScanner? = null
    private var callback: ScanCallback? = null

    val isScanning: Boolean
        get() = callback != null

    /** Idempotent. Permission model matches BleAdvertiser.start. */
    @SuppressLint("MissingPermission")
    fun start(context: Context) {
        if (callback != null) return
        val adapter = BleAdvertiser.bluetoothAdapter(context)
            ?: throw BleException("ERR_BLE_UNAVAILABLE", "No Bluetooth adapter on this device")
        val leScanner = adapter.bluetoothLeScanner
            ?: throw if (!BleAdvertiser.isEnabledSafe(adapter)) {
                BleException("ERR_BLE_DISABLED", "Bluetooth is turned off")
            } else {
                BleException("ERR_BLE_SCAN_UNSUPPORTED", "No BLE scanner available")
            }

        val filter = ScanFilter.Builder()
            .setManufacturerData(
                BleProtocol.COMPANY_ID,
                BleProtocol.MAGIC,
                BleProtocol.MAGIC_MASK,
            )
            .build()
        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_BALANCED)
            .setCallbackType(ScanSettings.CALLBACK_TYPE_ALL_MATCHES)
            .setReportDelay(0)
            .build()
        val cb = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                // The filter guarantees the record carries our company
                // ID; getManufacturerSpecificData returns the payload
                // with the company ID already stripped.
                val payload =
                    result.scanRecord?.getManufacturerSpecificData(BleProtocol.COMPANY_ID)
                        ?: return
                onSighting(payload, result.rssi, result.device.address)
            }

            override fun onBatchScanResults(results: MutableList<ScanResult>) {
                for (result in results) onScanResult(0, result)
            }

            override fun onScanFailed(errorCode: Int) {
                callback = null
                scanner = null
                onError("ERR_BLE_SCAN", describeScanError(errorCode))
            }
        }
        try {
            leScanner.startScan(listOf(filter), settings, cb)
        } catch (e: SecurityException) {
            throw BleException(
                "ERR_BLE_PERMISSION",
                "Missing Bluetooth scan permission: ${e.message}",
            )
        }
        scanner = leScanner
        callback = cb
    }

    @SuppressLint("MissingPermission")
    fun stop() {
        val cb = callback ?: return
        callback = null
        try {
            scanner?.stopScan(cb)
        } catch (_: SecurityException) {
            // Permission revoked mid-session; scan is already dead.
        } catch (_: IllegalStateException) {
            // Adapter turned off between start and stop.
        }
        scanner = null
    }

    private fun describeScanError(errorCode: Int): String = when (errorCode) {
        ScanCallback.SCAN_FAILED_ALREADY_STARTED -> "Scan already started"
        ScanCallback.SCAN_FAILED_APPLICATION_REGISTRATION_FAILED ->
            "Could not register scan with the Bluetooth stack"
        ScanCallback.SCAN_FAILED_INTERNAL_ERROR -> "Internal Bluetooth stack error"
        ScanCallback.SCAN_FAILED_FEATURE_UNSUPPORTED ->
            "Hardware-filtered scanning not supported on this device"
        ScanCallback.SCAN_FAILED_OUT_OF_HARDWARE_RESOURCES ->
            "No scan slot available (out of hardware resources)"
        ScanCallback.SCAN_FAILED_SCANNING_TOO_FREQUENTLY ->
            "Scanning too frequently; the OS is throttling this app"
        else -> "Scan failed (code $errorCode)"
    }
}
