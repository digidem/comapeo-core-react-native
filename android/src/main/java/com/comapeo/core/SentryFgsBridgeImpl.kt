package com.comapeo.core

import android.content.Context
import android.os.SystemClock
import android.util.Base64
import io.sentry.Breadcrumb
import io.sentry.ISpan
import io.sentry.ITransaction
import io.sentry.JsonObjectReader
import io.sentry.NoOpLogger
import io.sentry.Sentry
import io.sentry.IScope
import io.sentry.SentryAttribute
import io.sentry.SentryAttributes
import io.sentry.SentryDate
import io.sentry.SentryEvent
import io.sentry.SentryLevel
import io.sentry.SentryLogLevel
import io.sentry.SentryNanotimeDate
import io.sentry.SpanOptions
import io.sentry.SpanStatus
import io.sentry.TracesSamplingDecision
import io.sentry.TransactionContext
import io.sentry.TransactionOptions
import io.sentry.android.core.InternalSentrySdk
import io.sentry.android.core.SentryAndroid
import io.sentry.logger.SentryLogParameters
import org.json.JSONException
import org.json.JSONObject
import java.io.StringReader
import java.util.Date

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
        // Parse the backend-modules JSON once, here, rather than in
        // the event processor on every capture.
        val backendModules: Map<String, String>? =
            config.backendModulesJson?.let { json ->
                try {
                    val obj = JSONObject(json)
                    buildMap {
                        obj.keys().forEach { k -> put(k, obj.optString(k)) }
                    }
                } catch (_: JSONException) {
                    null
                }
            }

        SentryAndroid.init(context.applicationContext) { options ->
            options.isDebug = true
            options.setDiagnosticLevel(io.sentry.SentryLevel.DEBUG)
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
            // Mirrors initSentry's RN-side `comapeo.rn` global tag so
            // FGS captures + Node-forwarded events filter the same way.
            // event.modules is skipped (sentry-java's setter is
            // package-private).
            config.moduleVersion?.let { options.setTag("comapeo.rn", it) }
        }

        // SentryOptions has no "set context at init" hook; ride a
        // configureScope call after init.
        if (backendModules != null) {
            Sentry.configureScope { scope ->
                scope.setContexts("comapeoBackend", backendModules)
            }
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
    fun startBootTransaction(
        startElapsedRealtime: Long? = null,
        kind: String? = null,
    ): Any {
        val context = TransactionContext(
            "comapeo.boot",
            "boot",
            TracesSamplingDecision(true, 1.0),
        )
        val opts = TransactionOptions().apply {
            isBindToScope = true
            if (startElapsedRealtime != null) {
                startTimestamp = elapsedRealtimeToSentryDate(startElapsedRealtime)
            }
        }
        val tx = Sentry.startTransaction(context, opts)
        if (kind != null) tx.setTag(SentryTags.BOOT_KIND, kind)
        return tx
    }

    /** op = "boot.<phase>" because sentry-java has no separate
     *  `span.name`; Discover renders `span.name = op`. Filter
     *  `op:boot.*`. Phase taxonomy: see docs/ARCHITECTURE.md. */
    fun startBootSpan(
        transaction: Any,
        phase: String,
        startElapsedRealtime: Long? = null,
    ): Any {
        require(transaction is ITransaction) {
            "transaction must be ITransaction, got ${transaction.javaClass.name}"
        }
        val op = "boot.$phase"
        if (startElapsedRealtime != null) {
            // 3-arg overload (op, desc, SentryDate). The SpanOptions
            // overload in sentry-java 8.32 overwrites startTimestamp
            // with null before the Span constructor reads it.
            return transaction.startChild(
                op,
                op,
                elapsedRealtimeToSentryDate(startElapsedRealtime),
            )
        }
        return transaction.startChild(op, op)
    }

    /** `(sentryTrace, baggage)` for cross-process propagation via
     *  Node's `continueTrace`. Accepts `ISpan` so callers can pass
     *  either the transaction or the `node-spawn` span (we forward
     *  the span's header so Node spans nest under it). `baggage`
     *  null when no DSC. */
    fun getTraceData(handle: Any): Pair<String, String?> {
        require(handle is ISpan) {
            "handle must be ISpan, got ${handle.javaClass.name}"
        }
        val trace = handle.toSentryTrace().value
        val baggage = handle.toBaggageHeader(emptyList())?.value
        return trace to baggage
    }

    /**
     * elapsedRealtime (monotonic) → wall-clock SentryDate.
     *
     * `nanos` must be anchored to what `System.nanoTime()` would have
     * read at the backdated moment — sentry-java computes end via
     * `(end.nanos - start.nanos)` on top of start's wall-clock.
     * Passing `0` yields an end timestamp days in the future on
     * long-uptime devices, which Sentry rejects.
     */
    private fun elapsedRealtimeToSentryDate(startElapsedRealtime: Long): SentryDate {
        val nowWallMs = System.currentTimeMillis()
        val nowElapsed = SystemClock.elapsedRealtime()
        val nowNano = System.nanoTime()
        val startWallMs = nowWallMs - (nowElapsed - startElapsedRealtime)
        val startNanos = nowNano - (nowWallMs - startWallMs) * 1_000_000L
        return SentryNanotimeDate(Date(startWallMs), startNanos)
    }

    fun finishSpan(handle: Any, status: String) {
        // ITransaction extends ISpan; one path covers both.
        require(handle is ISpan) {
            "handle must be ISpan, got ${handle.javaClass.name}"
        }
        handle.status = parseStatus(status)
        handle.finish()
    }

    fun setSpanData(handle: Any, key: String, value: Any) {
        require(handle is ISpan) {
            "handle must be ISpan, got ${handle.javaClass.name}"
        }
        handle.setData(key, value)
    }

    fun flush(timeoutMillis: Long) {
        Sentry.flush(timeoutMillis)
    }

    /** See [SentryFgsBridge.captureEventJson]. */
    fun captureEventJson(payloadJson: String) {
        val reader = JsonObjectReader(StringReader(payloadJson))
        val event = SentryEvent.Deserializer().deserialize(reader, NoOpLogger.getInstance())
        Sentry.captureEvent(event)
    }

    /** `InternalSentrySdk.captureEnvelope(bytes, maybeStartNewSession)`
     *  is the hybrid-SDK entrypoint (rate-limit + offline-queue + same
     *  on-disk cache as native crashes). `false` matches
     *  @sentry/react-native's non-hardCrash path (no fresh session). */
    fun captureEnvelopeBase64(data: String) {
        val bytes = Base64.decode(data, Base64.DEFAULT)
        InternalSentrySdk.captureEnvelope(bytes, false)
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
