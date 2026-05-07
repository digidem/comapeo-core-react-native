package com.comapeo.core

import android.util.Log

const val TAG = "ComapeoCore"

/**
 * Single entry point for diagnostic output. Always writes a
 * logcat line at the matching priority; also forwards to
 * Sentry's structured-log pipeline (no-op when the consumer
 * hasn't opted in via `enableLogs: true` on the plugin).
 *
 * The semantic helpers (`logCrumb`, `logException`,
 * `logCapture`) compose on top of this — they each do this
 * `log` call plus their own Sentry breadcrumb / event.
 */
fun log(
    message: String,
    level: String = "debug",
    attributes: Map<String, Any?> = emptyMap(),
    throwable: Throwable? = null,
) {
    val line = if (attributes.isEmpty()) message else "$message $attributes"
    when (level) {
        "fatal", "error" -> if (throwable != null) Log.e(TAG, line, throwable) else Log.e(TAG, line)
        "warn", "warning" -> if (throwable != null) Log.w(TAG, line, throwable) else Log.w(TAG, line)
        "info" -> Log.i(TAG, line)
        else -> Log.d(TAG, line)
    }
    SentryFgsBridge.log(level, message, attributes)
}

/**
 * Log + Sentry breadcrumb. Use for app-lifecycle progress
 * events that ride on the next captured Sentry event but
 * don't fire one themselves.
 */
fun logCrumb(
    category: String,
    message: String,
    level: String = "info",
    data: Map<String, Any?> = emptyMap(),
) {
    log("[$category] $message", level, data + ("category" to category))
    SentryFgsBridge.addBreadcrumb(category, message, level, data)
}

/**
 * Log + Sentry captureException. Use when you have a
 * `Throwable` in hand: the stack lands in logcat (3-arg
 * `Log.e`) and on the Sentry event.
 */
fun logException(
    category: String,
    throwable: Throwable,
    message: String? = null,
    tags: Map<String, String> = emptyMap(),
) {
    val msg = message ?: throwable.message ?: throwable.javaClass.simpleName
    log(
        "[$category] $msg",
        level = "error",
        attributes = tags + mapOf(
            "category" to category,
            "exception.type" to throwable.javaClass.name,
        ),
        throwable = throwable,
    )
    SentryFgsBridge.captureException(throwable, tags)
}

/**
 * Log + Sentry captureMessage. Use for notable events that
 * aren't exceptions (timeouts, dropped frames, protocol
 * violations).
 */
fun logCapture(
    category: String,
    message: String,
    level: String = "info",
    tags: Map<String, String> = emptyMap(),
) {
    log("[$category] $message", level, tags + ("category" to category))
    SentryFgsBridge.captureMessage(message, level, tags)
}
