package com.comapeo.core.ble

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothProfile
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock

/**
 * Reads the CoMapeo sync-state characteristic from peers that advertise
 * the service UUID instead of manufacturer data — i.e. iPhones
 * (docs/ble-discovery.md §6c). The characteristic value is the same
 * 21-byte v1 payload, so a successful read feeds the same sighting
 * callback as an Android advertisement — the backend can't tell the
 * difference.
 *
 * One connection at a time (Android's concurrent-GATT budget is ~7 and
 * shared with the whole app), one read per device per
 * [READ_INTERVAL_MS], and a [READ_TIMEOUT_MS] watchdog because every
 * GATT step (connect, discover, read) can silently stall. All state is
 * confined to the main thread via [handler] — Bluetooth stack
 * callbacks arrive on binder threads.
 */
class GattStateReader(
    private val context: Context,
    private val onSighting: (payload: ByteArray, rssi: Int, address: String) -> Unit,
    private val nowMs: () -> Long = SystemClock::elapsedRealtime,
) {
    private val handler = Handler(Looper.getMainLooper())
    private val lastReadAt = HashMap<String, Long>()
    private val queue = ArrayDeque<Pair<BluetoothDevice, Int>>()
    private var activeGatt: BluetoothGatt? = null
    private var active = false

    /** Called from the scan callback on a service-UUID match. */
    fun request(device: BluetoothDevice, rssi: Int) {
        handler.post {
            val address = device.address
            val last = lastReadAt[address]
            val now = nowMs()
            if (last != null && now - last < READ_INTERVAL_MS) return@post
            if (queue.any { it.first.address == address }) return@post
            lastReadAt[address] = now
            pruneLastReadAt(now)
            queue.add(device to rssi)
            drain()
        }
    }

    fun clear() {
        handler.post {
            queue.clear()
            finishActive()
            lastReadAt.clear()
        }
    }

    // Main-thread only from here down.

    private fun drain() {
        if (active) return
        val (device, rssi) = queue.removeFirstOrNull() ?: return
        active = true
        read(device, rssi)
    }

    @SuppressLint("MissingPermission")
    private fun read(device: BluetoothDevice, rssi: Int) {
        val address = device.address
        val timeout = Runnable { finishActive() }
        handler.postDelayed(timeout, READ_TIMEOUT_MS)

        val callback = object : BluetoothGattCallback() {
            override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
                handler.post {
                    if (gatt !== activeGatt) return@post
                    if (newState == BluetoothProfile.STATE_CONNECTED) {
                        if (!gatt.discoverServices()) finish()
                    } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                        finish()
                    }
                }
            }

            override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
                handler.post {
                    if (gatt !== activeGatt) return@post
                    val characteristic = gatt
                        .getService(BleProtocol.SERVICE_UUID)
                        ?.getCharacteristic(BleProtocol.SYNC_STATE_CHARACTERISTIC_UUID)
                    if (characteristic == null || !gatt.readCharacteristic(characteristic)) {
                        finish()
                    }
                }
            }

            @Deprecated("Deprecated in API 33; the (gatt, characteristic, value, status) overload calls through here on older stacks")
            override fun onCharacteristicRead(
                gatt: BluetoothGatt,
                characteristic: BluetoothGattCharacteristic,
                status: Int,
            ) {
                val value = characteristic.value
                handler.post {
                    if (gatt !== activeGatt) return@post
                    if (status == BluetoothGatt.GATT_SUCCESS && value != null) {
                        onSighting(value, rssi, address)
                    }
                    finish()
                }
            }

            override fun onCharacteristicRead(
                gatt: BluetoothGatt,
                characteristic: BluetoothGattCharacteristic,
                value: ByteArray,
                status: Int,
            ) {
                handler.post {
                    if (gatt !== activeGatt) return@post
                    if (status == BluetoothGatt.GATT_SUCCESS) {
                        onSighting(value, rssi, address)
                    }
                    finish()
                }
            }

            private fun finish() {
                handler.removeCallbacks(timeout)
                finishActive()
            }
        }

        activeGatt = try {
            device.connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE)
        } catch (_: SecurityException) {
            null
        }
        if (activeGatt == null) {
            handler.removeCallbacks(timeout)
            finishActive()
        }
    }

    @SuppressLint("MissingPermission")
    private fun finishActive() {
        activeGatt?.let { gatt ->
            try {
                gatt.close()
            } catch (_: SecurityException) {
                // Permission revoked mid-read; nothing further to release.
            }
        }
        activeGatt = null
        if (active) {
            active = false
            drain()
        }
    }

    private fun pruneLastReadAt(now: Long) {
        if (lastReadAt.size <= MAX_TRACKED_DEVICES) return
        lastReadAt.entries.removeAll { (_, at) -> now - at > READ_INTERVAL_MS * 4 }
    }

    companion object {
        const val READ_INTERVAL_MS = 30_000L
        const val READ_TIMEOUT_MS = 10_000L
        const val MAX_TRACKED_DEVICES = 128
    }
}
