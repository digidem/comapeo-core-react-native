import os

private let logger = Logger(subsystem: "com.comapeo.core", category: "ComapeoCore")

func log(_ message: String) {
    logger.debug("\(message, privacy: .public)")
}

/// Log + Sentry breadcrumb in one call. The breadcrumb no-ops
/// when sentry-cocoa isn't on the runtime classpath; the
/// `os_log` line fires regardless.
func logCrumb(
    category: String,
    message: String,
    level: String = "info",
    data: [String: Any] = [:]
) {
    let logLine = data.isEmpty ? message : "\(message) \(data)"
    switch level {
    case "error", "fatal":
        logger.error("[\(category, privacy: .public)] \(logLine, privacy: .public)")
    case "warning", "warn":
        logger.warning("[\(category, privacy: .public)] \(logLine, privacy: .public)")
    case "debug":
        logger.debug("[\(category, privacy: .public)] \(logLine, privacy: .public)")
    default:
        logger.info("[\(category, privacy: .public)] \(logLine, privacy: .public)")
    }
    SentryNativeBridge.addBreadcrumb(category: category, message: message, level: level, data: data)
}

/// Log + Sentry captureException in one call. Use for caught
/// errors where you want a Sentry issue with the full stack.
func logException(
    category: String,
    error: Error,
    message: String? = nil,
    tags: [String: String] = [:]
) {
    let msg = message ?? error.localizedDescription
    logger.error("[\(category, privacy: .public)] \(msg, privacy: .public)")
    SentryNativeBridge.captureException(error, tags: tags)
}

/// Log + Sentry captureMessage in one call. No stack trace —
/// use [logException] when you have an error in hand.
func logCapture(
    category: String,
    message: String,
    level: String = "info",
    tags: [String: String] = [:]
) {
    switch level {
    case "fatal", "error":
        logger.error("[\(category, privacy: .public)] \(message, privacy: .public)")
    case "warning", "warn":
        logger.warning("[\(category, privacy: .public)] \(message, privacy: .public)")
    default:
        logger.info("[\(category, privacy: .public)] \(message, privacy: .public)")
    }
    SentryNativeBridge.captureMessage(message, level: level, tags: tags)
}
