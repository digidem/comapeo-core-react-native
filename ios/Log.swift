import os

private let logger = Logger(subsystem: "com.comapeo.core", category: "ComapeoCore")

func log(_ message: String) {
    logger.debug("\(message, privacy: .public)")
}

/// Log + Sentry breadcrumb in one call. Mirrors the Kotlin
/// helper so callsites on both platforms read the same.
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
