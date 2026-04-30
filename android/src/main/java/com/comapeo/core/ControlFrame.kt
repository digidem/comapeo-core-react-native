package com.comapeo.core

import org.json.JSONException
import org.json.JSONObject

/**
 * Typed representation of a control-socket frame received from the
 * embedded Node.js backend. Replaces the parse+`when (type)` chain that
 * was duplicated across `NodeJSService.handleControlMessage` (FGS-side)
 * and `ComapeoCoreModule`'s `onMessage` (main-app-side).
 *
 * Frame names match what `backend/lib/simple-rpc.js` emits and what
 * `backend/index.js` broadcasts. Adding a new frame type means adding
 * a case here AND a branch on each consumer's `when` — the compiler's
 * exhaustiveness check is the point: a forgotten branch fails to
 * build, rather than silently dropping the frame at runtime.
 *
 * `Malformed` is a single case covering "non-JSON" and "JSON without a
 * usable type" — the consumers don't need to distinguish them today,
 * and the human-readable detail is what gets surfaced to JS via
 * `messageerror` regardless of which produced it.
 */
sealed class ControlFrame {
    object Started : ControlFrame()
    object Ready : ControlFrame()
    data class Error(val phase: String, val message: String) : ControlFrame()

    /**
     * The frame could not be processed: not JSON, missing `type`, or
     * `type` not in the well-known set. `detail` is a developer-facing
     * description suitable for logs and the JS `messageerror` event.
     */
    data class Malformed(val detail: String) : ControlFrame()

    companion object {
        /**
         * Parses a raw control-socket message into a typed frame.
         * Never throws; every failure mode resolves to `Malformed`.
         */
        fun parse(raw: String): ControlFrame {
            val json = try {
                JSONObject(raw)
            } catch (_: JSONException) {
                return Malformed("Non-JSON control frame: ${raw.take(100)}")
            }
            val type = json.optString("type", "")
            return when (type) {
                "started" -> Started
                "ready" -> Ready
                "error" -> Error(
                    phase = json.optString("phase", "unknown"),
                    message = json.optString("message", "(no message)"),
                )
                else -> Malformed("Unknown control frame type=\"$type\"")
            }
        }
    }
}
