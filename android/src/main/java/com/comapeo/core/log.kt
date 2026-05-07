package com.comapeo.core

import android.util.Log

const val TAG = "ComapeoCore"

fun log(msg: String) {
    Log.d(TAG, msg)
}

/**
 * Log + Sentry breadcrumb in one call. The breadcrumb is a
 * no-op when the FGS-process Sentry SDK isn't initialised;
 * the logcat line fires regardless.
 *
 * Use for app-lifecycle progress events that ride on the next
 * captured Sentry event but don't fire one themselves.
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

/**
 * Log + Sentry captureException in one call. The throwable's
 * stack is preserved in logcat (`Log.e(TAG, msg, t)` 3-arg
 * form) and on the Sentry event.
 *
 * Use for caught exceptions where you want a Sentry issue with
 * the full stack trace.
 */
fun logException(
    category: String,
    throwable: Throwable,
    message: String? = null,
    tags: Map<String, String> = emptyMap(),
) {
    val msg = message ?: throwable.message ?: throwable.javaClass.simpleName
    Log.e(TAG, "[$category] $msg", throwable)
    SentryFgsBridge.captureException(throwable, tags)
}

/**
 * Log + Sentry captureMessage in one call. No stack trace —
 * use [logException] when you have a throwable.
 *
 * Use for notable events that aren't exceptions (timeouts,
 * dropped frames, protocol violations).
 */
fun logCapture(
    category: String,
    message: String,
    level: String = "info",
    tags: Map<String, String> = emptyMap(),
) {
    when (level) {
        "fatal", "error" -> Log.e(TAG, "[$category] $message")
        "warning", "warn" -> Log.w(TAG, "[$category] $message")
        else -> Log.i(TAG, "[$category] $message")
    }
    SentryFgsBridge.captureMessage(message, level, tags)
}
