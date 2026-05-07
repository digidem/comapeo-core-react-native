package com.comapeo.core

import android.content.Context
import io.sentry.Breadcrumb
import io.sentry.ISpan
import io.sentry.ITransaction
import io.sentry.Sentry
import io.sentry.IScope
import io.sentry.SentryAttribute
import io.sentry.SentryAttributes
import io.sentry.SentryLevel
import io.sentry.SentryLogLevel
import io.sentry.SpanStatus
import io.sentry.TracesSamplingDecision
import io.sentry.TransactionContext
import io.sentry.TransactionOptions
import io.sentry.android.core.SentryAndroid
import io.sentry.logger.SentryLogParameters

/**
 * Implementation behind [SentryFgsBridge]. Contains every
 * `io.sentry.*` import in the module's main source set; the
 * Guard's `Class.forName` probe must be the only path that
 * reaches this class so consumers without sentry-android never
 * load it. All methods assume the bridge has already verified
 * the SDK is present.
 */
internal object SentryFgsBridgeImpl {

    fun init(context: Context, config: SentryConfig) {
        SentryAndroid.init(context.applicationContext) { options ->
            options.dsn = config.dsn
            options.environment = config.environment
            options.release = config.release
            options.sampleRate = config.sampleRate ?: 1.0
            options.tracesSampleRate = config.tracesSampleRate ?: 0.0
            // Structured logs default off; opt in via the plugin's
            // `enableLogs: true`. SDK no-ops `Sentry.logger().*` when
            // false so the helpers can route unconditionally.
            options.logs.isEnabled = config.enableLogs == true
            options.setTag(SentryTags.PROC, SentryTags.PROC_FGS)
            options.setTag(SentryTags.LAYER, SentryTags.LAYER_NATIVE)
        }
    }

    /**
     * Forward a log entry to the Sentry Logs UI. SDK gates the
     * call on `options.logs.isEnabled`, so callers don't need
     * their own check.
     */
    fun log(level: String, message: String, attributes: Map<String, Any?>) {
        val attrs = attributes.entries
            .mapNotNull { (k, v) -> v?.let { sentryAttribute(k, it) } }
            .toTypedArray()
        val params = SentryLogParameters.create(SentryAttributes.of(*attrs))
        Sentry.logger().log(parseLogLevel(level), params, message)
    }

    private fun sentryAttribute(key: String, value: Any): SentryAttribute = when (value) {
        is String -> SentryAttribute.stringAttribute(key, value)
        is Boolean -> SentryAttribute.booleanAttribute(key, value)
        is Int -> SentryAttribute.integerAttribute(key, value)
        // No `longAttribute` factory; `named` lets the SDK pick the
        // wire type and avoids the precision loss of `toInt()`.
        is Long -> SentryAttribute.named(key, value)
        is Double -> SentryAttribute.doubleAttribute(key, value)
        is Float -> SentryAttribute.doubleAttribute(key, value.toDouble())
        else -> SentryAttribute.stringAttribute(key, value.toString())
    }

    private fun parseLogLevel(level: String): SentryLogLevel = when (level.lowercase()) {
        "trace" -> SentryLogLevel.TRACE
        "debug" -> SentryLogLevel.DEBUG
        "warn", "warning" -> SentryLogLevel.WARN
        "error" -> SentryLogLevel.ERROR
        "fatal" -> SentryLogLevel.FATAL
        else -> SentryLogLevel.INFO
    }

    fun addBreadcrumb(
        category: String,
        message: String,
        level: String,
        data: Map<String, Any?>,
    ) {
        val crumb = Breadcrumb().apply {
            this.category = category
            this.message = message
            this.level = parseLevel(level)
            for ((k, v) in data) {
                if (v != null) setData(k, v)
            }
        }
        Sentry.addBreadcrumb(crumb)
    }

    fun captureException(
        throwable: Throwable,
        tags: Map<String, String>,
    ) {
        Sentry.captureException(throwable) { scope -> applyTags(scope, tags) }
    }

    fun captureMessage(
        message: String,
        level: String,
        tags: Map<String, String>,
    ) {
        Sentry.captureMessage(message, parseLevel(level)) { scope -> applyTags(scope, tags) }
    }

    private fun applyTags(scope: IScope, tags: Map<String, String>) {
        tags.forEach { (k, v) -> scope.setTag(k, v) }
    }

    /**
     * Returns an `ITransaction` typed as `Any` — keeps `io.sentry.*`
     * out of the Guard's signature surface.
     *
     * `TracesSamplingDecision(true, 1.0)` overrides
     * `tracesSampleRate` so the boot transaction lands on the
     * wire even when consumers run with `tracesSampleRate=0.0`.
     */
    fun startBootTransaction(): Any {
        val context = TransactionContext(
            "comapeo.boot",
            "boot",
            TracesSamplingDecision(true, 1.0),
        )
        val opts = TransactionOptions().apply { isBindToScope = true }
        return Sentry.startTransaction(context, opts)
    }

    fun startBootSpan(transaction: Any, phase: String): Any {
        require(transaction is ITransaction) {
            "transaction must be ITransaction, got ${transaction.javaClass.name}"
        }
        val description = when (phase) {
            "rootkey-load" -> "Load 16-byte rootkey from RootKeyStore"
            "init-frame" -> "Send init frame, await ready"
            else -> phase
        }
        return transaction.startChild("boot.$phase", description)
    }

    fun finishSpan(handle: Any, status: String) {
        // ITransaction extends ISpan; one path covers both.
        require(handle is ISpan) {
            "handle must be ISpan, got ${handle.javaClass.name}"
        }
        handle.status = parseStatus(status)
        handle.finish()
    }

    fun flush(timeoutMillis: Long) {
        Sentry.flush(timeoutMillis)
    }

    private fun parseLevel(level: String): SentryLevel = when (level.lowercase()) {
        "fatal" -> SentryLevel.FATAL
        "error" -> SentryLevel.ERROR
        "warning", "warn" -> SentryLevel.WARNING
        "debug" -> SentryLevel.DEBUG
        else -> SentryLevel.INFO
    }

    private fun parseStatus(status: String): SpanStatus = when (status.lowercase()) {
        "ok" -> SpanStatus.OK
        "internal_error", "error" -> SpanStatus.INTERNAL_ERROR
        "deadline_exceeded", "timeout" -> SpanStatus.DEADLINE_EXCEEDED
        "cancelled" -> SpanStatus.CANCELLED
        "not_found" -> SpanStatus.NOT_FOUND
        "unauthenticated" -> SpanStatus.UNAUTHENTICATED
        else -> SpanStatus.UNKNOWN
    }
}
