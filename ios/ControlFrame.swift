import Foundation

/// Typed control-socket frame from the Node backend. Mirrors the Android
/// `ControlFrame` sealed class.
///
/// Adding a new frame type means a case here AND a branch on each
/// consumer's switch — Swift exhaustiveness is the point.
enum ControlFrame {
    case started
    case ready
    /// Backend has begun graceful shutdown. A control-socket close
    /// without a preceding `.stopping` is unambiguously a crash or kill.
    case stopping
    case error(phase: String, message: String)
    /// Sentry error event from `@sentry/node`, forwarded as JSON for
    /// `SentryEventDecoder.decodeEvent(jsonData:)`. Native scope (device,
    /// OS, app, user) merges so Node doesn't have to carry it.
    case sentryEvent(payloadJson: String)
    /// Sentry envelope from `@sentry/node` (transactions, sessions,
    /// check-ins, profiles). Base64 bytes handed to
    /// `PrivateSentrySDKOnly`. No native scope merging.
    case sentryEnvelope(data: String)
    /// Not JSON, missing `type`, or `type` not in the well-known set.
    /// `detail` is developer-facing — surfaces in the JS `messageerror`.
    case malformed(detail: String)

    /// Never throws; every failure resolves to `.malformed`.
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
            // Re-stringify so the decoder can re-parse from bytes.
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
