import os

private let logger = Logger(subsystem: "com.comapeo.core", category: "ComapeoCore")

enum LogLevel: String {
    case trace, debug, info, warning, error, fatal
}

/// Single entry point for diagnostic output. Writes an `os_log` line and
/// forwards to Sentry's structured-log pipeline (no-op when the host
/// hasn't enabled logs at SDK init).
func log(
    _ message: String,
    level: LogLevel = .debug,
    attributes: [String: Any] = [:]
) {
    let line = attributes.isEmpty ? message : "\(message) \(attributes)"
    switch level {
    case .fatal, .error:
        logger.error("\(line, privacy: .public)")
    case .warning:
        logger.warning("\(line, privacy: .public)")
    case .info:
        logger.info("\(line, privacy: .public)")
    case .trace, .debug:
        logger.debug("\(line, privacy: .public)")
    }
    SentryNativeBridge.log(level: level, message: message, attributes: attributes)
}

/// Log + Sentry breadcrumb. For app-lifecycle progress events that ride
/// on the next captured Sentry event but don't fire one themselves.
func logCrumb(
    category: String,
    message: String,
    level: LogLevel = .info,
    data: [String: Any] = [:]
) {
    var attrs = data
    attrs["category"] = category
    log("[\(category)] \(message)", level: level, attributes: attrs)
    SentryNativeBridge.addBreadcrumb(category: category, message: message, level: level, data: data)
}

/// Log + Sentry captureException. Use when you have an `Error` in hand —
/// the Sentry event carries the full stack.
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
    log("[\(category)] \(msg)", level: .error, attributes: attrs)
    SentryNativeBridge.captureException(error, tags: tags)
}

/// Log + Sentry captureMessage. For notable non-exception events
/// (timeouts, dropped frames, protocol violations).
func logCapture(
    category: String,
    message: String,
    level: LogLevel = .info,
    tags: [String: String] = [:]
) {
    var attrs: [String: Any] = tags
    attrs["category"] = category
    log("[\(category)] \(message)", level: level, attributes: attrs)
    SentryNativeBridge.captureMessage(message, level: level, tags: tags)
}
