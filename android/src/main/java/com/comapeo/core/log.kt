package com.comapeo.core

import android.util.Log

const val TAG = "ComapeoCore"

/**
 * Single diagnostic entry point. Writes a logcat line at the matching priority
 * and forwards to Sentry's structured-log pipeline (no-op without
 * `enableLogs: true`). The semantic helpers below compose on top of this.
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

/** Log + Sentry breadcrumb. For lifecycle progress that rides the next event. */
fun logCrumb(
    category: String,
    message: String,
    level: String = "info",
    data: Map<String, Any?> = emptyMap(),
) {
    log("[$category] $message", level, data + ("category" to category))
    SentryFgsBridge.addBreadcrumb(category, message, level, data)
}

/** Log + Sentry captureException. Stack lands in logcat (3-arg Log.e) and on the event. */
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

/** Log + Sentry captureMessage. For notable non-exception events (timeouts, drops, …). */
fun logCapture(
    category: String,
    message: String,
    level: String = "info",
    tags: Map<String, String> = emptyMap(),
) {
    log("[$category] $message", level, tags + ("category" to category))
    SentryFgsBridge.captureMessage(message, level, tags)
}

/**
 * Sentry counter metric. Unsampled (unlike spans), so use it for fleet-wide rates and
 * fractions; reserve events for cases needing a stack/message. No logcat line — call
 * sites already log their state string.
 */
fun metricCount(name: String, attributes: Map<String, String> = emptyMap()) {
    SentryFgsBridge.countMetric(name, attributes)
}
