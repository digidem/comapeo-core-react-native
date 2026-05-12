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

    /**
     * Backend has begun graceful shutdown. Sent before any close work so
     * peers can distinguish "expected disconnect" from "unexpected
     * disconnect" — a control socket that closes without a preceding
     * `Stopping` is unambiguously a crash or kill, not a graceful exit.
     */
    object Stopping : ControlFrame()

    data class Error(val phase: String, val message: String) : ControlFrame()

    /**
     * A Sentry error event captured by `@sentry/node` in the embedded
     * backend. Forwarded as a JSON string so the FGS-side
     * `sentry-android` SDK can deserialize via `SentryEvent.Deserializer`
     * and capture via `Sentry.captureEvent(...)` — that path applies
     * the native scope (device, OS, app, user, native breadcrumbs) so
     * Node doesn't have to carry it. The string is the re-serialized
     * event payload; the consumer feeds it straight to the deserializer.
     */
    data class SentryEvent(val payloadJson: String) : ControlFrame()

    /**
     * A Sentry envelope captured by `@sentry/node` in the embedded
     * backend — used for transactions, sessions, check-ins, profiles,
     * and any multi-item event payload. Forwarded as base64-encoded
     * bytes and handed to `sentry-android` / `sentry-cocoa`'s
     * hybrid-SDK envelope-capture entrypoint, which queues and retries
     * under the device's connectivity-aware offline transport. Native
     * scope is NOT applied — irrelevant for transactions (the parent
     * transaction is opened natively and Node spans inherit its
     * scope via `continueTrace`), and the other item types don't
     * carry user-facing fields anyway.
     */
    data class SentryEnvelope(val data: String) : ControlFrame()

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
                "stopping" -> Stopping
                "error" -> Error(
                    phase = json.optString("phase", "unknown"),
                    message = json.optString("message", "(no message)"),
                )
                "sentry-event" -> {
                    val payload = json.optJSONObject("payload")
                    if (payload == null) {
                        Malformed("sentry-event frame missing object `payload`")
                    } else {
                        // Re-serialize to a JSON string for the
                        // deserializer. The outer parser already
                        // walked the payload tree; re-stringify so
                        // `SentryEvent.Deserializer` can re-parse
                        // against the bytes it expects.
                        SentryEvent(payload.toString())
                    }
                }
                "sentry-envelope" -> {
                    val data = json.optString("data", "")
                    if (data.isEmpty()) {
                        Malformed("sentry-envelope frame missing string `data`")
                    } else {
                        SentryEnvelope(data)
                    }
                }
                else -> Malformed("Unknown control frame type=\"$type\"")
            }
        }
    }
}
