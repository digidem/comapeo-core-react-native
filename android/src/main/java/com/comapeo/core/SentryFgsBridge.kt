package com.comapeo.core

import android.content.Context
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import io.sentry.Breadcrumb
import io.sentry.IScope
import io.sentry.ISpan
import io.sentry.ITransaction
import io.sentry.JsonObjectReader
import io.sentry.NoOpLogger
import io.sentry.Sentry
import io.sentry.SentryAttribute
import io.sentry.SentryAttributes
import io.sentry.SentryDate
import io.sentry.SentryEvent
import io.sentry.SentryLevel
import io.sentry.SentryLogLevel
import io.sentry.SentryNanotimeDate
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
 * Entry point to the Sentry-Android SDK from the `:ComapeoCore`
 * FGS process.
 *
 * Android creates a fresh `Application` per process, so the host's
 * `SentryAndroid.init` (run from `MainApplication.onCreate`) never
 * reaches `:ComapeoCore` — this object re-runs init in the FGS
 * process from `ComapeoCoreService.onCreate`.
 *
 * Pre-init behaviour: every public method short-circuits to a clean
 * no-op until [init] runs. The FGS process is created before
 * `onCreate` fires, so any JNI-side or early-listener call can land
 * before init; gating here prevents an SDK API surface from being
 * touched before `SentryAndroid.init` has wired the hub.
 *
 * Per-call try/catch: a thrown Sentry call must not take the FGS
 * down — the FGS's job is to keep nodejs-mobile alive, and
 * observability is decorative relative to that.
 */
object SentryFgsBridge {
    @Volatile
    private var initialized: Boolean = false

    /**
     * Idempotent. Caller must pass a non-null `SentryConfig` —
     * `SentryConfig.loadFromManifest` returns null when no DSN is
     * present, in which case don't call this method at all.
     */
    @JvmStatic
    fun init(context: Context, config: SentryConfig) {
        if (initialized) return
        try {
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

            initialized = true
        } catch (t: Throwable) {
            Log.e(TAG, "SentryFgsBridge.init failed; continuing without FGS Sentry", t)
        }
    }

    /**
     * Severity strings are loose: `info` / `warning` / `error` /
     * `fatal` / `debug`. Unknown values fall back to `info`.
     */
    @JvmStatic
    @JvmOverloads
    fun addBreadcrumb(
        category: String,
        message: String,
        level: String = "info",
        data: Map<String, Any?> = emptyMap(),
    ) {
        if (!initialized) return
        try {
            val crumb = Breadcrumb().apply {
                this.category = category
                this.message = message
                this.level = parseLevel(level)
                for ((k, v) in data) {
                    if (v != null) setData(k, v)
                }
            }
            Sentry.addBreadcrumb(crumb)
        } catch (t: Throwable) {
            Log.w(TAG, "addBreadcrumb($category) threw", t)
        }
    }

    @JvmStatic
    @JvmOverloads
    fun captureException(
        throwable: Throwable,
        tags: Map<String, String> = emptyMap(),
    ) {
        if (!initialized) return
        try {
            Sentry.captureException(throwable) { scope -> applyTags(scope, tags) }
        } catch (t: Throwable) {
            Log.w(TAG, "captureException threw", t)
        }
    }

    @JvmStatic
    @JvmOverloads
    fun captureMessage(
        message: String,
        level: String = "info",
        tags: Map<String, String> = emptyMap(),
    ) {
        if (!initialized) return
        try {
            Sentry.captureMessage(message, parseLevel(level)) { scope -> applyTags(scope, tags) }
        } catch (t: Throwable) {
            Log.w(TAG, "captureMessage threw", t)
        }
    }

    /**
     * Forward to Sentry's structured-log pipeline. SDK silently
     * drops the call when `options.logs.isEnabled = false`, so
     * callers don't need their own gate.
     */
    @JvmStatic
    @JvmOverloads
    fun log(
        level: String,
        message: String,
        attributes: Map<String, Any?> = emptyMap(),
    ) {
        if (!initialized) return
        try {
            val attrs = attributes.entries
                .mapNotNull { (k, v) -> v?.let { sentryAttribute(k, it) } }
                .toTypedArray()
            val params = SentryLogParameters.create(SentryAttributes.of(*attrs))
            Sentry.logger().log(parseLogLevel(level), params, message)
        } catch (t: Throwable) {
            Log.w(TAG, "log($level) threw", t)
        }
    }

    /**
     * Returns an opaque handle (`null` when pre-init). Pass back to
     * [startBootSpan] / [finishSpan]. Opaque `Any?` keeps `io.sentry.*`
     * out of the caller's bytecode.
     *
     * @param startElapsedRealtime `SystemClock.elapsedRealtime()` value
     *   to backdate the transaction start to. `null` → start now.
     * @param kind Value for the `boot.kind` tag — `user-foreground`
     *   when the activity initiated the start, `system-restart` when
     *   Android brought the FGS back without an intent. `null` skips
     *   the tag (test convenience).
     *
     * `TracesSamplingDecision(true, 1.0)` overrides
     * `tracesSampleRate` so the boot transaction lands on the
     * wire even when consumers run with `tracesSampleRate=0.0`.
     */
    @JvmStatic
    @JvmOverloads
    fun startBootTransaction(
        startElapsedRealtime: Long? = null,
        kind: String? = null,
    ): Any? {
        if (!initialized) return null
        return try {
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
            tx
        } catch (t: Throwable) {
            Log.w(TAG, "startBootTransaction threw", t)
            null
        }
    }

    /**
     * op = "boot.<phase>" because sentry-java has no separate
     * `span.name`; Discover renders `span.name = op`. Filter
     * `op:boot.*`. Phase taxonomy: see docs/ARCHITECTURE.md.
     *
     * @param startElapsedRealtime `SystemClock.elapsedRealtime()` value
     *   to backdate the span start to. `null` → start now.
     */
    @JvmStatic
    @JvmOverloads
    fun startBootSpan(
        transaction: Any?,
        phase: String,
        startElapsedRealtime: Long? = null,
    ): Any? {
        if (!initialized || transaction == null) return null
        return try {
            require(transaction is ITransaction) {
                "transaction must be ITransaction, got ${transaction.javaClass.name}"
            }
            val op = "boot.$phase"
            if (startElapsedRealtime != null) {
                // 3-arg overload (op, desc, SentryDate). The SpanOptions
                // overload in sentry-java 8.32 overwrites startTimestamp
                // with null before the Span constructor reads it.
                transaction.startChild(
                    op,
                    op,
                    elapsedRealtimeToSentryDate(startElapsedRealtime),
                )
            } else {
                transaction.startChild(op, op)
            }
        } catch (t: Throwable) {
            Log.w(TAG, "startBootSpan($phase) threw", t)
            null
        }
    }

    /**
     * Distributed-trace headers for the supplied transaction. Used by
     * `NodeJSService` to forward the FGS-side `comapeo.boot` context
     * to Node via `--sentryTrace`/`--sentryBaggage` argv so Node-side
     * spans land as children of the same transaction. Accepts `ISpan`
     * so callers can pass either the transaction or the `node-spawn`
     * span; baggage is null when no DSC.
     */
    @JvmStatic
    fun getTraceData(handle: Any?): Pair<String, String?>? {
        if (!initialized || handle == null) return null
        return try {
            require(handle is ISpan) {
                "handle must be ISpan, got ${handle.javaClass.name}"
            }
            val trace = handle.toSentryTrace().value
            val baggage = handle.toBaggageHeader(emptyList())?.value
            trace to baggage
        } catch (t: Throwable) {
            Log.w(TAG, "getTraceData threw", t)
            null
        }
    }

    /**
     * Hand a JSON-serialised Sentry error event (captured by
     * `@sentry/node` in the embedded backend) to `sentry-android`.
     * Decoded via `SentryEvent.Deserializer` and captured via
     * `Sentry.captureEvent`, so the FGS-side SDK's scope (device,
     * OS, app, user, native breadcrumbs) is merged at capture time —
     * Node doesn't have to carry that context. Riding `captureEvent`
     * means we also inherit the offline-capable transport.
     */
    @JvmStatic
    fun captureEventJson(payloadJson: String) {
        if (!initialized) return
        try {
            val reader = JsonObjectReader(StringReader(payloadJson))
            val event = SentryEvent.Deserializer().deserialize(reader, NoOpLogger.getInstance())
            Sentry.captureEvent(event)
        } catch (t: Throwable) {
            Log.w(TAG, "captureEventJson threw", t)
        }
    }

    /**
     * Hand a base64-encoded Sentry envelope (captured by `@sentry/node`
     * for transactions, sessions, check-ins, profiles, or any multi-item
     * payload) to `sentry-android`'s offline-capable transport. Native
     * scope is NOT applied — see the `SentryEnvelope` case in
     * `ControlFrame` for why that's fine here.
     *
     * `InternalSentrySdk.captureEnvelope(bytes, maybeStartNewSession)`
     * is the hybrid-SDK entrypoint (rate-limit + offline-queue + same
     * on-disk cache as native crashes). `false` matches
     * @sentry/react-native's non-hardCrash path (no fresh session).
     */
    @JvmStatic
    fun captureEnvelopeBase64(data: String) {
        if (!initialized) return
        try {
            val bytes = Base64.decode(data, Base64.DEFAULT)
            InternalSentrySdk.captureEnvelope(bytes, false)
        } catch (t: Throwable) {
            Log.w(TAG, "captureEnvelopeBase64 threw", t)
        }
    }

    /** `status` is `"ok"`, `"internal_error"`, `"deadline_exceeded"`, or `"cancelled"`. */
    @JvmStatic
    @JvmOverloads
    fun finishSpan(handle: Any?, status: String = "ok") {
        if (!initialized || handle == null) return
        try {
            // ITransaction extends ISpan; one path covers both.
            require(handle is ISpan) {
                "handle must be ISpan, got ${handle.javaClass.name}"
            }
            handle.status = parseStatus(status)
            handle.finish()
        } catch (t: Throwable) {
            Log.w(TAG, "finishSpan($status) threw", t)
        }
    }

    /** Span-data (key/value) for one-shot facts; queryable as
     *  `span.data["<key>"]`. No-op on missing handle / pre-init. */
    @JvmStatic
    fun setSpanData(handle: Any?, key: String, value: Any) {
        if (!initialized || handle == null) return
        try {
            require(handle is ISpan) {
                "handle must be ISpan, got ${handle.javaClass.name}"
            }
            handle.setData(key, value)
        } catch (t: Throwable) {
            Log.w(TAG, "setSpanData($key) threw", t)
        }
    }

    /**
     * Synchronously flush queued events. Call before
     * `Process.killProcess` (FGS shutdown timeout) so a "stop
     * timeout" capture isn't dropped along with the process.
     */
    @JvmStatic
    fun flush(timeoutMillis: Long) {
        if (!initialized) return
        try {
            Sentry.flush(timeoutMillis)
        } catch (t: Throwable) {
            Log.w(TAG, "flush threw", t)
        }
    }

    /** Test-only — reset the init flag. */
    @JvmStatic
    internal fun resetForTests() {
        initialized = false
    }

    /**
     * Test-only — mark the bridge initialised so per-call methods
     * route into the SDK. JVM unit tests use the cross-platform
     * `Sentry.init(SentryOptions)` (no Android Context) to set up
     * the hub and then call this to flip the local gate without
     * invoking `SentryAndroid.init` (which needs `SystemClock`,
     * unmocked on the JVM classpath).
     */
    @JvmStatic
    internal fun markInitializedForTests() {
        initialized = true
    }

    private fun applyTags(scope: IScope, tags: Map<String, String>) {
        tags.forEach { (k, v) -> scope.setTag(k, v) }
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

    private const val TAG = "ComapeoCore.Sentry"
}
