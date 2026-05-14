import Foundation
// `@_spi(Private)` opts in to `SentryEventDecoder.decodeEvent(jsonData:)`
// — the JSON → SentryEvent path sentry-cocoa exposes for hybrid SDKs.
// The selector is the same one `SentryFileManager.readAppHangEvent`
// uses internally, so this is exercised on every cocoa release. Symbol
// stability is gated by the `Sentry/HybridSDK` version pin in
// `ComapeoCore.podspec` and the matching SPM pin in `Package.swift`;
// re-validate when bumping.
@_spi(Private) import Sentry

/// Emits breadcrumbs, captures, and spans against the host's
/// already-initialised sentry-cocoa hub. Single-process on iOS so
/// no separate init like Android's FGS — the host's
/// `@sentry/react-native` ran `SentrySDK.startWith(...)` already.
/// `proc:main` and `layer:native` tag per-call (we don't own the
/// SDK scope).
///
/// `Sentry/HybridSDK` is a hard pod dep (`ComapeoCore.podspec`) and
/// Sentry-Cocoa is a hard SPM dep (`Package.swift`), so the `Sentry`
/// module is on the import path under both build modes. Opt-in is
/// preserved at runtime: `SentrySDK` no-ops every call until the host
/// calls `Sentry.init(...)` (which happens via the JS-side
/// `initSentry()`).
enum SentryNativeBridge {

    static func addBreadcrumb(
        category: String,
        message: String,
        level: String = "info",
        data: [String: Any] = [:]
    ) {
        let crumb = Breadcrumb()
        crumb.category = category
        crumb.message = message
        crumb.level = parseLevel(level)
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
        level: String = "info",
        tags: [String: String] = [:]
    ) {
        SentrySDK.capture(message: message) { scope in
            scope.setLevel(parseLevel(level))
            applyDefaultTags(scope)
            for (k, v) in tags { scope.setTag(value: v, key: k) }
        }
    }

    /// Forward to Sentry's structured-log pipeline. The Cocoa SDK
    /// silently drops the call when the host hasn't enabled logs
    /// at init time (the host's `@sentry/react-native` config
    /// owns the SDK options on iOS — there's no separate process
    /// like Android's FGS).
    static func log(
        level: String,
        message: String,
        attributes: [String: Any] = [:]
    ) {
        let attrs = attributes.compactMapValues { $0 }
        switch level.lowercased() {
        case "trace":
            attrs.isEmpty ? SentrySDK.logger.trace(message)
                          : SentrySDK.logger.trace(message, attributes: attrs)
        case "info":
            attrs.isEmpty ? SentrySDK.logger.info(message)
                          : SentrySDK.logger.info(message, attributes: attrs)
        case "warn", "warning":
            attrs.isEmpty ? SentrySDK.logger.warn(message)
                          : SentrySDK.logger.warn(message, attributes: attrs)
        case "error":
            attrs.isEmpty ? SentrySDK.logger.error(message)
                          : SentrySDK.logger.error(message, attributes: attrs)
        case "fatal":
            attrs.isEmpty ? SentrySDK.logger.fatal(message)
                          : SentrySDK.logger.fatal(message, attributes: attrs)
        default:
            attrs.isEmpty ? SentrySDK.logger.debug(message)
                          : SentrySDK.logger.debug(message, attributes: attrs)
        }
    }

    /// Returns an opaque transaction handle. `Any?` keeps the rest
    /// of the iOS module free of Sentry references.
    static func startBootTransaction() -> Any? {
        // `sampled: .yes` overrides global `tracesSampleRate` so
        // the boot transaction always reaches the wire.
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

    /// op = "boot.<phase>" because sentry-cocoa has no separate
    /// `span.name`; Discover renders `span.name = op`. Filter
    /// `op:boot.*`. Phase taxonomy: see docs/ARCHITECTURE.md.
    static func startBootSpan(_ transaction: Any?, phase: String) -> Any? {
        guard let tx = transaction as? Span else { return nil }
        let op = "boot.\(phase)"
        return tx.startChild(operation: op, description: op)
    }

    static func finishSpan(_ handle: Any?, status: String = "ok") {
        guard let span = handle as? Span else { return }
        span.status = parseStatus(status)
        span.finish()
    }

    /// Span-data (key/value) for one-shot facts; queryable as
    /// `span.data["<key>"]`.
    static func setSpanData(_ handle: Any?, key: String, value: Any) {
        guard let span = handle as? Span else { return }
        span.setData(value: value, key: key)
    }

    /// Decode Node event JSON via `SentryEventDecoder` (SPI but
    /// internally exercised by sentry-cocoa) and capture via
    /// `SentrySDK.capture(event:)` so native scope (device/OS/app/user)
    /// merges. Malformed payload dropped silently.
    static func captureEventJson(_ payloadJson: String) {
        guard let data = payloadJson.data(using: .utf8) else { return }
        guard let event = SentryEventDecoder.decodeEvent(jsonData: data) else { return }
        SentrySDK.capture(event: event)
    }

    /// Hand a base64-encoded Sentry envelope to sentry-cocoa's hybrid
    /// envelope-capture entrypoint. Same offline-transport as
    /// `captureEventJson` but without native scope merging (envelopes
    /// carry their own).
    ///
    /// `#if !SWIFT_PACKAGE` because `PrivateSentrySDKOnly.envelope(with:)`
    /// and `PrivateSentrySDKOnly.capture(_:)` live in sentry-cocoa's
    /// `PrivateHeaders/` and are reachable only through the
    /// `Sentry/HybridSDK` CocoaPods subspec — sentry-cocoa's SPM
    /// binary xcframework ships the umbrella headers, not the private
    /// ones. SPM consumers of `Sentry` can't see these symbols, so we
    /// stub the method out for the `swift test` build path. No SPM
    /// test exercises envelope-capture; the on-device CocoaPods build
    /// retains the full implementation.
    static func captureEnvelopeBase64(_ data: String) {
        #if !SWIFT_PACKAGE
        guard let bytes = Data(base64Encoded: data) else { return }
        guard let envelope = PrivateSentrySDKOnly.envelope(with: bytes) else { return }
        PrivateSentrySDKOnly.capture(envelope)
        #endif
    }

    /// Trace header for cross-process propagation to the Node hub.
    /// Node's `Sentry.continueTrace` uses it to nest boot spans under
    /// `comapeo.boot`. Returns `(trace, nil)` — baggage is omitted
    /// (Android forwards it; cocoa@8 has no equivalent on its public
    /// Span API and the SPI shape isn't stable across versions). The
    /// DSC drop is benign: trace_id alone stitches parent/child, and
    /// boot transactions are forced-sampled so the sample-rate field
    /// the DSC would carry doesn't gate ingestion. Re-evaluate if
    /// non-boot tracing on iOS adopts the same path.
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

    private static func parseLevel(_ level: String) -> SentryLevel {
        switch level.lowercased() {
        case "fatal": return .fatal
        case "error": return .error
        case "warning", "warn": return .warning
        case "debug": return .debug
        default: return .info
        }
    }

    private static func parseStatus(_ status: String) -> SentrySpanStatus {
        switch status.lowercased() {
        case "ok": return .ok
        case "internal_error", "error": return .internalError
        case "deadline_exceeded", "timeout": return .deadlineExceeded
        case "cancelled": return .cancelled
        default: return .undefined
        }
    }
}
