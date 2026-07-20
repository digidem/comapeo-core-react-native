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
     * BLE engine commands from the backend's discovery controller
     * (`backend/lib/ble-discovery.js`), which owns the whole discovery
     * lifecycle. Broadcast frames — the FGS's [NodeJSService] dispatches
     * them to the engine; every other control client ignores them.
     * `payload` is the base64 v1 advertisement (null = scan-only /
     * stop advertising).
     */
    data class BleStart(val payload: String?) : ControlFrame()
    data class BleAdvertise(val payload: String?) : ControlFrame()
    object BleStop : ControlFrame()

    /**
     * DNS-SD engine commands, same contract as the BLE ones: the
     * backend's discovery controller tells the FGS-hosted [NsdEngine]
     * to register `_comapeo._tcp` as `name`:`port` and browse for
     * peers, or to stop.
     */
    data class NsdStart(val name: String, val port: Int) : ControlFrame()
    object NsdStop : ControlFrame()

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
                "ble-start" -> BleStart(payload = json.optStringOrNull("payload"))
                "ble-advertise" -> BleAdvertise(payload = json.optStringOrNull("payload"))
                "ble-stop" -> BleStop
                "nsd-start" -> {
                    val name = json.optString("name", "")
                    val port = json.optInt("port", 0)
                    if (name.isEmpty() || port <= 0) {
                        Malformed("nsd-start frame missing `name`/`port`")
                    } else {
                        NsdStart(name = name, port = port)
                    }
                }
                "nsd-stop" -> NsdStop
                else -> Malformed("Unknown control frame type=\"$type\"")
            }
        }

        /** `null` for an absent key or a JSON `null` value. */
        private fun JSONObject.optStringOrNull(key: String): String? =
            if (isNull(key)) null else optString(key)
    }
}
