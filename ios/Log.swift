import os

private let logger = Logger(subsystem: "com.comapeo.core", category: "ComapeoCore")

/// Single entry point for diagnostic output. Always writes an
/// `os_log` line at the matching priority; also forwards to
/// Sentry's structured-log pipeline (no-op when the host
/// hasn't enabled logs at init time).
///
/// The semantic helpers (`logCrumb`, `logException`,
/// `logCapture`) compose on top of this — they each do this
/// `log` call plus their own Sentry breadcrumb / event.
func log(
    _ message: String,
    level: String = "debug",
    attributes: [String: Any] = [:]
) {
    let line = attributes.isEmpty ? message : "\(message) \(attributes)"
    switch level {
    case "fatal", "error":
        logger.error("\(line, privacy: .public)")
    case "warn", "warning":
        logger.warning("\(line, privacy: .public)")
    case "info":
        logger.info("\(line, privacy: .public)")
    default:
        logger.debug("\(line, privacy: .public)")
    }
    SentryNativeBridge.log(level: level, message: message, attributes: attributes)
}

/// Log + Sentry breadcrumb. Use for app-lifecycle progress
/// events that ride on the next captured Sentry event but
/// don't fire one themselves.
func logCrumb(
    category: String,
    message: String,
    level: String = "info",
    data: [String: Any] = [:]
) {
    var attrs = data
    attrs["category"] = category
    log("[\(category)] \(message)", level: level, attributes: attrs)
    SentryNativeBridge.addBreadcrumb(category: category, message: message, level: level, data: data)
}

/// Log + Sentry captureException. Use when you have an
/// `Error` in hand — the Sentry event carries the full stack.
func logException(
    category: String,
    error: Error,
    message: String? = nil,
    tags: [String: String] = [:]
) {
    let msg = message ?? error.localizedDescription
    var attrs: [String: Any] = tags
    attrs["category"] = category
    attrs["exception.type"] = String(describing: type(of: error))
    log("[\(category)] \(msg)", level: "error", attributes: attrs)
    SentryNativeBridge.captureException(error, tags: tags)
}

/// Log + Sentry captureMessage. Use for notable events that
/// aren't exceptions (timeouts, dropped frames, protocol
/// violations).
func logCapture(
    category: String,
    message: String,
    level: String = "info",
    tags: [String: String] = [:]
) {
    var attrs: [String: Any] = tags
    attrs["category"] = category
    log("[\(category)] \(message)", level: level, attributes: attrs)
    SentryNativeBridge.captureMessage(message, level: level, tags: tags)
}
