import Foundation
// `@_spi(Private)` opts in to `SentryEventDecoder.decodeEvent(jsonData:)` —
// the JSON → SentryEvent path sentry-cocoa exposes for hybrid SDKs. Stability
// is gated by the `Sentry/HybridSDK` pin in `ComapeoCore.podspec` and the
// matching SPM pin in `Package.swift`; re-validate when bumping.
@_spi(Private) import Sentry

enum SpanStatus: String {
    case ok
    case internalError = "internal_error"
    case deadlineExceeded = "deadline_exceeded"
    case cancelled
    case undefined
}

/// Emits breadcrumbs, captures, and spans against the host's
/// already-initialised sentry-cocoa hub. iOS is single-process so the
/// host's `@sentry/react-native` runs `SentrySDK.startWith(...)` first;
/// every call here no-ops until then.
enum SentryNativeBridge {

    static func addBreadcrumb(
        category: String,
        message: String,
        level: LogLevel = .info,
        data: [String: Any] = [:]
    ) {
        let crumb = Breadcrumb()
        crumb.category = category
        crumb.message = message
        crumb.level = level.sentryLevel
        if !data.isEmpty {
            crumb.data = data
        }
        SentrySDK.addBreadcrumb(crumb)
    }

    static func captureException(_ error: Error, tags: [String: String] = [:]) {
        SentrySDK.capture(error: error) { scope in
            applyDefaultTags(scope)
            for (k, v) in tags { scope.setTag(value: v, key: k) }
        }
    }

    static func captureMessage(
        _ message: String,
        level: LogLevel = .info,
        tags: [String: String] = [:]
    ) {
        SentrySDK.capture(message: message) { scope in
            scope.setLevel(level.sentryLevel)
            applyDefaultTags(scope)
            for (k, v) in tags { scope.setTag(value: v, key: k) }
        }
    }

    /// Forward to Sentry's structured-log pipeline. The Cocoa SDK drops
    /// the call silently when the host hasn't enabled logs at init.
    static func log(
        level: LogLevel,
        message: String,
        attributes: [String: Any] = [:]
    ) {
        let attrs = attributes.compactMapValues { $0 }
        let logger = SentrySDK.logger
        switch level {
        case .trace: logger.trace(message, attributes: attrs)
        case .info: logger.info(message, attributes: attrs)
        case .warning: logger.warn(message, attributes: attrs)
        case .error: logger.error(message, attributes: attrs)
        case .fatal: logger.fatal(message, attributes: attrs)
        case .debug: logger.debug(message, attributes: attrs)
        }
    }

    /// `Any?` keeps Sentry types out of caller signatures.
    static func startBootTransaction() -> Any? {
        // `sampled: .yes` overrides global `tracesSampleRate` so the boot
        // transaction always reaches the wire.
        let context = TransactionContext(
            name: "comapeo.boot",
            operation: "boot",
            sampled: .yes
        )
        let tx = SentrySDK.startTransaction(
            transactionContext: context,
            customSamplingContext: [:]
        )
        applyDefaultTags(toSpan: tx)
        return tx
    }

    /// `op = "boot.<phase>"`: cocoa has no separate `span.name`, Discover
    /// renders `span.name = op`. Filter `op:boot.*`.
    static func startBootSpan(_ transaction: Any?, phase: String) -> Any? {
        guard let tx = transaction as? Span else { return nil }
        let op = "boot.\(phase)"
        return tx.startChild(operation: op, description: op)
    }

    static func finishSpan(_ handle: Any?, status: SpanStatus = .ok) {
        guard let span = handle as? Span else { return }
        span.status = status.sentrySpanStatus
        span.finish()
    }

    /// Span-data (key/value) for one-shot facts; queryable as
    /// `span.data["<key>"]`.
    static func setSpanData(_ handle: Any?, key: String, value: Any) {
        guard let span = handle as? Span else { return }
        span.setData(value: value, key: key)
    }

    /// Decode Node event JSON via `SentryEventDecoder` (SPI but exercised
    /// internally by sentry-cocoa) and capture so native scope
    /// (device/OS/app/user) merges. Malformed payload dropped silently.
    static func captureEventJson(_ payloadJson: String) {
        guard let data = payloadJson.data(using: .utf8) else { return }
        guard let event = SentryEventDecoder.decodeEvent(jsonData: data) else { return }
        SentrySDK.capture(event: event)
    }

    /// Hand a base64-encoded Sentry envelope to sentry-cocoa's hybrid
    /// envelope-capture entrypoint. Native scope is NOT applied;
    /// envelopes carry their own.
    ///
    /// `#if !SWIFT_PACKAGE` because `PrivateSentrySDKOnly` lives in
    /// sentry-cocoa's CocoaPods-only `PrivateHeaders/`. SPM consumers
    /// can't see these symbols; we stub it out for `swift test`. The
    /// on-device CocoaPods build retains the full implementation.
    static func captureEnvelopeBase64(_ data: String) {
        #if !SWIFT_PACKAGE
        guard let bytes = Data(base64Encoded: data) else { return }
        guard let envelope = PrivateSentrySDKOnly.envelope(with: bytes) else { return }
        PrivateSentrySDKOnly.capture(envelope)
        #endif
    }

    /// Trace header for cross-process propagation to the Node hub. Node's
    /// `Sentry.continueTrace` uses it to nest boot spans under
    /// `comapeo.boot`. Baggage is omitted — cocoa@8 has no public Span
    /// API for it and the SPI shape isn't stable across versions; the DSC
    /// drop is benign because boot transactions are forced-sampled.
    static func getTraceData(_ transaction: Any?) -> (trace: String, baggage: String?)? {
        guard let tx = transaction as? Span else { return nil }
        return (tx.toTraceHeader().value(), nil)
    }

    private static func applyDefaultTags(_ scope: Scope) {
        scope.setTag(value: SentryTags.procMain, key: SentryTags.proc)
        scope.setTag(value: SentryTags.layerNative, key: SentryTags.layer)
    }

    private static func applyDefaultTags(toSpan span: Span) {
        span.setTag(value: SentryTags.procMain, key: SentryTags.proc)
        span.setTag(value: SentryTags.layerNative, key: SentryTags.layer)
    }
}

private extension LogLevel {
    var sentryLevel: SentryLevel {
        switch self {
        case .fatal: return .fatal
        case .error: return .error
        case .warning: return .warning
        case .debug, .trace: return .debug
        case .info: return .info
        }
    }
}

private extension SpanStatus {
    var sentrySpanStatus: SentrySpanStatus {
        switch self {
        case .ok: return .ok
        case .internalError: return .internalError
        case .deadlineExceeded: return .deadlineExceeded
        case .cancelled: return .cancelled
        case .undefined: return .undefined
        }
    }
}
