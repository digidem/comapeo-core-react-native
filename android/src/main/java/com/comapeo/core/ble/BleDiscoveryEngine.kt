package com.comapeo.core.ble

import android.content.Context
import android.os.SystemClock
import android.util.Base64
import org.json.JSONObject

/**
 * The FGS-hosted half of BLE discovery: owns the radios in the
 * `:ComapeoCore` process so advertising and scanning survive the main
 * app process being backgrounded or killed (the same reason the Node
 * backend lives there — see docs/ble-discovery.md "process model").
 *
 * All *policy* lives elsewhere: the main-process module composes the
 * advertisement payload (opaque bytes here) and drives this engine via
 * service intents; the Node backend receives the frames this engine
 * emits over the control socket and decides what to do with sightings
 * (relay to observers + auto-`connectLocalPeer`).
 *
 * Frames sent to Node (via [sendFrame], best-effort):
 * - `ble-own {payload|null}` — what this device is advertising. Sent
 *   *before* the radio call so the backend's connect policy works even
 *   on hardware that can't advertise (scan-only budget chipsets).
 * - `ble-sighting {payload, rssi, address}` — throttled scan results.
 * - `ble-error {scope, code, message}` — radio failures (both the
 *   synchronous start failures, since intents have no reply channel,
 *   and the async callback ones).
 *
 * Errors never throw out of this class: with an intent-driven engine
 * there is nobody to catch them — everything is reported as a frame.
 */
class BleDiscoveryEngine(
    private val context: Context,
    private val sendFrame: (String) -> Unit,
    private val throttle: SightingThrottle = SightingThrottle(),
    private val nowMs: () -> Long = SystemClock::elapsedRealtime,
) {
    private val advertiser = BleAdvertiser { code, message ->
        sendError("advertise", code, message)
    }
    private val scanner = BleScanner(
        onSighting = { payload, rssi, address ->
            if (throttle.shouldForward(address, payload, nowMs())) {
                sendFrame(
                    JSONObject()
                        .put("type", "ble-sighting")
                        .put("payload", Base64.encodeToString(payload, Base64.NO_WRAP))
                        .put("rssi", rssi)
                        .put("address", address)
                        .toString(),
                )
            }
        },
        onError = { code, message -> sendError("scan", code, message) },
    )

    var isRunning: Boolean = false
        private set

    /** Start scanning and (when [payload] is non-null) advertising.
     *  Safe to call repeatedly — a running scan is kept, the
     *  advertisement is replaced. */
    fun start(payload: ByteArray?) {
        isRunning = true
        try {
            scanner.start(context)
        } catch (e: BleException) {
            sendError("scan", e.code, e.message ?: "scan start failed")
        }
        setAdvertisement(payload)
    }

    /** Replace (non-null) or stop (null) the advertisement. No-op when
     *  the engine isn't running. */
    fun setAdvertisement(payload: ByteArray?) {
        if (!isRunning) return
        // Own-state first: the backend can auto-connect on sightings
        // even if the advertise call below fails on this hardware.
        sendFrame(
            JSONObject()
                .put("type", "ble-own")
                .put(
                    "payload",
                    payload?.let { Base64.encodeToString(it, Base64.NO_WRAP) } ?: JSONObject.NULL,
                )
                .toString(),
        )
        if (payload == null) {
            advertiser.stop()
            return
        }
        try {
            advertiser.start(context, payload)
        } catch (e: BleException) {
            sendError("advertise", e.code, e.message ?: "advertise start failed")
        }
    }

    fun stop() {
        if (!isRunning) return
        isRunning = false
        advertiser.stop()
        scanner.stop()
        throttle.clear()
    }

    private fun sendError(scope: String, code: String, message: String) {
        sendFrame(
            JSONObject()
                .put("type", "ble-error")
                .put("scope", scope)
                .put("code", code)
                .put("message", message)
                .toString(),
        )
    }
}
