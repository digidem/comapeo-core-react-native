import Foundation

/// Typed representation of a control-socket frame received from the
/// embedded Node.js backend. Replaces the ad-hoc parse + switch-on-type
/// pattern in `NodeJSService.handleControlMessage` and aligns 1:1 with
/// the Android `ControlFrame` sealed class so the same protocol surface
/// is described in one type per platform.
///
/// Frame names match what `backend/lib/simple-rpc.js` emits and what
/// `backend/index.js` broadcasts. Adding a new frame type means adding
/// a case here AND a branch on each consumer's `switch` — Swift's
/// exhaustiveness check is the point: a forgotten branch fails to
/// build, rather than silently dropping the frame at runtime.
///
/// `.malformed(detail:)` is a single case covering "non-JSON" and "JSON
/// without a usable type" — consumers don't need to distinguish them
/// today, and the human-readable detail is what gets surfaced to JS via
/// `messageerror` regardless of which produced it.
enum ControlFrame {
    case started
    case ready
    /// Backend has begun graceful shutdown. Sent before any close work so
    /// peers can distinguish "expected disconnect" from "unexpected
    /// disconnect" — a control socket that closes without a preceding
    /// `.stopping` is unambiguously a crash or kill, not a graceful exit.
    case stopping
    case error(phase: String, message: String)
    /// A Sentry error event captured by `@sentry/node` in the embedded
    /// backend. Forwarded as a JSON string so sentry-cocoa can decode
    /// via `SentryEventDecoder.decodeEvent(jsonData:)` and capture
    /// via `SentrySDK.capture(event:)` — that path applies the native
    /// scope (device, OS, app, user, native breadcrumbs) so Node
    /// doesn't have to carry it.
    case sentryEvent(payloadJson: String)
    /// A Sentry envelope captured by `@sentry/node` — used for
    /// transactions, sessions, check-ins, profiles, and any multi-item
    /// event payload. Forwarded as base64-encoded bytes and handed
    /// to `PrivateSentrySDKOnly.envelope(with:)` + `captureEnvelope`.
    /// Native scope is NOT applied; irrelevant for transactions
    /// (parent transaction is opened natively, Node spans inherit
    /// its scope via `continueTrace`) and the other item types don't
    /// carry user-facing fields.
    case sentryEnvelope(data: String)
    /// The frame could not be processed: not JSON, missing `type`, or
    /// `type` not in the well-known set. `detail` is a developer-facing
    /// description suitable for logs and the JS `messageerror` event.
    case malformed(detail: String)

    /// Parses a raw control-socket message into a typed frame.
    /// Never throws; every failure mode resolves to `.malformed`.
    static func parse(_ raw: String) -> ControlFrame {
        guard let data = raw.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return .malformed(detail: "Non-JSON control frame: \(raw.prefix(100))")
        }
        let type = (obj["type"] as? String) ?? ""
        switch type {
        case "started":
            return .started
        case "ready":
            return .ready
        case "stopping":
            return .stopping
        case "error":
            let phase = (obj["phase"] as? String) ?? "unknown"
            let message = (obj["message"] as? String) ?? "(no message)"
            return .error(phase: phase, message: message)
        case "sentry-event":
            guard let payload = obj["payload"] as? [String: Any] else {
                return .malformed(detail: "sentry-event frame missing object `payload`")
            }
            // Re-serialize to a JSON string for the decoder. The
            // outer parser already walked the payload tree;
            // re-stringify so `SentryEventDecoder.decodeEvent(jsonData:)`
            // can re-parse against the bytes it expects.
            guard let bytes = try? JSONSerialization.data(withJSONObject: payload, options: []),
                  let json = String(data: bytes, encoding: .utf8)
            else {
                return .malformed(detail: "sentry-event frame `payload` is not serializable JSON")
            }
            return .sentryEvent(payloadJson: json)
        case "sentry-envelope":
            guard let data = obj["data"] as? String else {
                return .malformed(detail: "sentry-envelope frame missing string `data`")
            }
            return .sentryEnvelope(data: data)
        default:
            return .malformed(detail: "Unknown control frame type=\"\(type)\"")
        }
    }
}
