import Foundation

#if canImport(Sentry)
import Sentry
#endif

/// Emits breadcrumbs, captures, and spans against the host's
/// already-initialised sentry-cocoa hub. Single-process on iOS so
/// no separate init like Android's FGS — the host's
/// `@sentry/react-native` ran `SentrySDK.startWith(...)` already.
/// `proc:main` and `layer:native` tag per-call (we don't own the
/// SDK scope).
///
/// `#if canImport(Sentry)` gates every Sentry reference: when the
/// `Sentry` pod isn't in the consumer's Podfile (no
/// `@sentry/react-native`), the `#else` branches compile to no-ops.
enum SentryNativeBridge {

    static func addBreadcrumb(
        category: String,
        message: String,
        level: String = "info",
        data: [String: Any] = [:]
    ) {
        #if canImport(Sentry)
        let crumb = Breadcrumb()
        crumb.category = category
        crumb.message = message
        crumb.level = parseLevel(level)
        if !data.isEmpty {
            crumb.data = data
        }
        SentrySDK.addBreadcrumb(crumb)
        #endif
    }

    static func captureException(_ error: Error, tags: [String: String] = [:]) {
        #if canImport(Sentry)
        SentrySDK.capture(error: error) { scope in
            applyDefaultTags(scope)
            for (k, v) in tags { scope.setTag(value: v, key: k) }
        }
        #endif
    }

    static func captureMessage(
        _ message: String,
        level: String = "info",
        tags: [String: String] = [:]
    ) {
        #if canImport(Sentry)
        SentrySDK.capture(message: message) { scope in
            scope.setLevel(parseLevel(level))
            applyDefaultTags(scope)
            for (k, v) in tags { scope.setTag(value: v, key: k) }
        }
        #endif
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
        #if canImport(Sentry)
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
        #endif
    }

    /// Returns an opaque transaction handle. `Any?` keeps the rest
    /// of the iOS module free of Sentry references.
    static func startBootTransaction() -> Any? {
        #if canImport(Sentry)
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
        #else
        return nil
        #endif
    }

    static func startBootSpan(_ transaction: Any?, phase: String) -> Any? {
        #if canImport(Sentry)
        guard let tx = transaction as? Span else { return nil }
        let description: String
        switch phase {
        case "rootkey-load": description = "Load 16-byte rootkey from RootKeyStore"
        case "init-frame": description = "Send init frame, await ready"
        default: description = phase
        }
        return tx.startChild(operation: "boot.\(phase)", description: description)
        #else
        return nil
        #endif
    }

    static func finishSpan(_ handle: Any?, status: String = "ok") {
        #if canImport(Sentry)
        guard let span = handle as? Span else { return }
        span.status = parseStatus(status)
        span.finish()
        #endif
    }

    #if canImport(Sentry)
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
    #endif
}
