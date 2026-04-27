import os

private let logger = Logger(subsystem: "com.comapeo.core", category: "ComapeoCore")

func log(_ message: String) {
    logger.debug("\(message, privacy: .public)")
}
