package com.comapeo.core

import android.util.Log

const val TAG = "ComapeoCore"

fun log(msg: String) {
    Log.d(TAG, msg)
}

/**
 * Log + Sentry breadcrumb in one call. Replaces the
 * `log("foo"); SentryFgsBridge.addBreadcrumb(...)` pair at
 * callsites that want both.
 *
 * The breadcrumb is a no-op when the FGS-process Sentry SDK
 * isn't initialised (consumer didn't register the plugin or
 * isn't using `@sentry/react-native`); the logcat line still
 * fires regardless.
 */
fun logCrumb(
    category: String,
    message: String,
    level: String = "info",
    data: Map<String, Any?> = emptyMap(),
) {
    val logLine = if (data.isEmpty()) message else "$message $data"
    when (level) {
        "error", "fatal" -> Log.e(TAG, "[$category] $logLine")
        "warning", "warn" -> Log.w(TAG, "[$category] $logLine")
        "debug" -> Log.d(TAG, "[$category] $logLine")
        else -> Log.i(TAG, "[$category] $logLine")
    }
    SentryFgsBridge.addBreadcrumb(category, message, level, data)
}
