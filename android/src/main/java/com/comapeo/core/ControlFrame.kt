package com.comapeo.core

import org.json.JSONException
import org.json.JSONObject

/**
 * Typed control-socket frame from the embedded Node.js backend. Names match what
 * `backend/lib/simple-rpc.js` emits / `backend/index.js` broadcasts. The compiler's
 * exhaustiveness check on consumers is the point — adding a frame fails the build
 * until every `when` is updated, rather than silently dropping it at runtime.
 */
sealed class ControlFrame {
    object Started : ControlFrame()
    object Ready : ControlFrame()

    /** Graceful shutdown — sent before close so peers can tell expected from crash. */
    object Stopping : ControlFrame()

    data class Error(val phase: String, val message: String) : ControlFrame()

    /**
     * `@sentry/node` error event, JSON-encoded. Fed to `SentryEvent.Deserializer`
     * + `Sentry.captureEvent` so native scope (device/OS/app/user) is merged at
     * capture time and Node doesn't have to carry it.
     */
    data class SentryEvent(val payloadJson: String) : ControlFrame()

    /**
     * `@sentry/node` envelope (transactions, sessions, check-ins, profiles, …)
     * base64-encoded. Handed to the hybrid-SDK envelope entrypoint for offline-
     * capable transport. Native scope is NOT applied — parent transaction is
     * opened natively and Node spans inherit via `continueTrace`.
     */
    data class SentryEnvelope(val data: String) : ControlFrame()

    /**
     * A BLE peer sighting relayed by the backend (`lib/ble-discovery.js`
     * re-broadcasts accepted `ble-sighting` frames). Consumed by the
     * main-process `ComapeoBleDiscoveryModule` observer; the FGS and the
     * core module ignore it. `payload` is the base64 v1 advertisement.
     */
    data class BlePeer(val payload: String, val rssi: Int, val address: String) : ControlFrame()

    /**
     * A BLE radio failure relayed by the backend (originates in the
     * FGS-hosted engine, round-trips via Node so every observer hears it).
     */
    data class BleError(val scope: String, val code: String, val message: String) : ControlFrame()

    /** Frame could not be processed; `detail` is suitable for logs / `messageerror`. */
    data class Malformed(val detail: String) : ControlFrame()

    companion object {
        /** Never throws; every failure mode resolves to [Malformed]. */
        fun parse(raw: String): ControlFrame {
            val json = try {
                JSONObject(raw)
            } catch (_: JSONException) {
                return Malformed("Non-JSON control frame: ${raw.take(100)}")
            }
            return when (val type = json.optString("type", "")) {
                "started" -> Started
                "ready" -> Ready
                "stopping" -> Stopping
                "error" -> Error(
                    phase = json.optString("phase", "unknown"),
                    message = json.optString("message", "(no message)"),
                )
                "sentry-event" -> {
                    val payload = json.optJSONObject("payload")
                    // Re-serialize so SentryEvent.Deserializer can re-parse against the bytes it expects.
                    payload?.let { SentryEvent(it.toString()) }
                        ?: Malformed("sentry-event frame missing object `payload`")
                }
                "sentry-envelope" -> {
                    val data = json.optString("data", "")
                    if (data.isEmpty()) Malformed("sentry-envelope frame missing string `data`")
                    else SentryEnvelope(data)
                }
                "ble-peer" -> {
                    val payload = json.optString("payload", "")
                    if (payload.isEmpty()) {
                        Malformed("ble-peer frame missing string `payload`")
                    } else {
                        BlePeer(
                            payload = payload,
                            rssi = json.optInt("rssi", 0),
                            address = json.optString("address", ""),
                        )
                    }
                }
                "ble-error" -> BleError(
                    scope = json.optString("scope", "unknown"),
                    code = json.optString("code", "ERR_BLE"),
                    message = json.optString("message", "(no message)"),
                )
                else -> Malformed("Unknown control frame type=\"$type\"")
            }
        }
    }
}
