package com.comapeo.core.ble

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject

/**
 * The FGS-hosted half of BLE discovery: owns the radios in the
 * `:ComapeoCore` process so advertising and scanning survive the main
 * app process being backgrounded or killed — the same reason the Node
 * backend lives there (docs/ble-discovery.md §4a/§6).
 *
 * All *policy* lives in the backend's discovery controller: it composes
 * the advertisement (opaque bytes here) and drives this engine via
 * `ble-start` / `ble-advertise` / `ble-stop` control frames; the engine
 * answers with:
 *
 * - `ble-sighting {payload, rssi, address}` — throttled scan results
 *   (from Android manufacturer-data advertisements AND from GATT reads
 *   of iOS peers via [GattStateReader] — same frame, indistinguishable
 *   to the backend).
 * - `ble-status {scanning, advertising, blockers, lastError?}` — the
 *   engine's view of the radios, surfaced to the front end as
 *   `DiscoveryState.ble`. Radio failures never throw out of this
 *   class: frames are the only reply channel.
 *
 * **Threading.** Commands (`start`/`setAdvertisement`/`stop`) arrive on
 * the control-IPC coroutine, while the scanner/advertiser/GATT
 * callbacks fire on the Bluetooth stack's main looper. To keep the
 * shared state (`scanning`/`advertising`/`blockers`/`lastError`/
 * `isRunning`) and the [SightingThrottle] map single-threaded, every
 * public method hops onto [handler] (the main looper) — the same
 * confinement [NsdEngine] and [GattStateReader] use. `isRunning` is
 * additionally `@Volatile` because [ComapeoCoreService] reads it off
 * the handler thread.
 */
class BleDiscoveryEngine(
    private val context: Context,
    private val sendFrame: (String) -> Unit,
    private val throttle: SightingThrottle = SightingThrottle(),
    private val nowMs: () -> Long = SystemClock::elapsedRealtime,
) {
    private val handler = Handler(Looper.getMainLooper())
    private var scanning = "stopped"
    private var advertising = "stopped"
    private val blockers = LinkedHashSet<String>()
    private var lastError: Triple<String, String, String>? = null

    private val advertiser = BleAdvertiser { code, message ->
        // Async advertise failure — hop to the handler so it can't race
        // an in-flight command mutating the same state.
        handler.post {
            advertising = if (code == "ERR_BLE_ADVERTISE") "unavailable" else advertising
            recordError("advertise", code, message)
            sendStatus()
        }
    }
    private val gattReader = GattStateReader(context, onSighting = ::forwardSighting)
    private val scanner = BleScanner(
        onSighting = ::forwardSighting,
        onError = { code, message ->
            handler.post {
                scanning = "unavailable"
                recordError("scan", code, message)
                sendStatus()
            }
        },
        onServiceMatch = { device, rssi -> gattReader.request(device, rssi) },
    )

    @Volatile
    var isRunning: Boolean = false
        private set

    /** Start scanning and (when [payload] is non-null) advertising.
     *  Safe to call repeatedly — a running scan is kept, the
     *  advertisement is replaced. */
    fun start(payload: ByteArray?) {
        handler.post {
            isRunning = true
            blockers.clear()
            lastError = null
            scanning = try {
                scanner.start(context)
                "active"
            } catch (e: BleException) {
                recordError("scan", e.code, e.message ?: "scan start failed")
                "unavailable"
            }
            applyAdvertisement(payload)
            sendStatus()
        }
    }

    /** Replace (non-null) or stop (null) the advertisement. No-op when
     *  the engine isn't running. */
    fun setAdvertisement(payload: ByteArray?) {
        handler.post {
            if (!isRunning) return@post
            applyAdvertisement(payload)
            sendStatus()
        }
    }

    fun stop() {
        handler.post {
            if (!isRunning) return@post
            isRunning = false
            advertiser.stop()
            scanner.stop()
            gattReader.clear()
            throttle.clear()
            scanning = "stopped"
            advertising = "stopped"
            sendStatus()
        }
    }

    // Handler-thread only from here down.

    private fun applyAdvertisement(payload: ByteArray?) {
        if (payload == null) {
            advertiser.stop()
            advertising = "stopped"
            return
        }
        advertising = try {
            advertiser.start(context, payload)
            "active"
        } catch (e: BleException) {
            recordError("advertise", e.code, e.message ?: "advertise start failed")
            if (e.code == "ERR_BLE_ADVERTISE_UNSUPPORTED") "unsupported" else "unavailable"
        }
    }

    private fun forwardSighting(payload: ByteArray, rssi: Int, address: String) {
        if (!throttle.shouldForward(address, payload, nowMs())) return
        sendFrame(
            JSONObject()
                .put("type", "ble-sighting")
                .put("payload", Base64.encodeToString(payload, Base64.NO_WRAP))
                .put("rssi", rssi)
                .put("address", address)
                .toString(),
        )
    }

    private fun recordError(scope: String, code: String, message: String) {
        blockerFor(code)?.let(blockers::add)
        lastError = Triple(scope, code, message)
    }

    private fun sendStatus() {
        val frame = JSONObject()
            .put("type", "ble-status")
            .put("scanning", scanning)
            .put("advertising", advertising)
            .put("blockers", JSONArray(blockers.toList()))
        lastError?.let { (scope, code, message) ->
            frame.put(
                "lastError",
                JSONObject()
                    .put("scope", scope)
                    .put("code", code)
                    .put("message", message),
            )
        }
        sendFrame(frame.toString())
    }

    companion object {
        /**
         * Maps engine error codes onto the actionable blockers the
         * front end renders ("Turn on Bluetooth", permission prompt…).
         * Pure — see [BleDiscoveryEngineTest].
         */
        fun blockerFor(code: String): String? = when (code) {
            "ERR_BLE_DISABLED" -> "bluetooth-off"
            "ERR_BLE_UNAVAILABLE" -> "no-adapter"
            "ERR_BLE_PERMISSION" -> "permission-missing"
            else -> null
        }
    }
}
