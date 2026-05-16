package com.comapeo.core

import android.content.Context
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import io.sentry.Breadcrumb
import io.sentry.EventProcessor
import io.sentry.Hint
import io.sentry.IScope
import io.sentry.ISpan
import io.sentry.ITransaction
import io.sentry.JsonObjectReader
import io.sentry.NoOpLogger
import io.sentry.Sentry
import io.sentry.SentryAttribute
import io.sentry.SentryAttributes
import io.sentry.SentryBaseEvent
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
import io.sentry.protocol.SentryTransaction
import org.json.JSONException
import org.json.JSONObject
import java.io.StringReader
import java.util.Date

/**
 * Sentry-Android SDK entry point in the `:ComapeoCore` FGS process.
 *
 * Android creates a fresh `Application` per process, so the host's
 * `SentryAndroid.init` never reaches the FGS — this object re-runs init from
 * `ComapeoCoreService.onCreate`.
 *
 * Pre-init guard: every public method no-ops until [init] runs. The FGS process
 * starts before `onCreate`, so early callers can land before init.
 *
 * Per-call try/catch: a thrown Sentry call must never take the FGS down —
 * keeping nodejs-mobile alive is the FGS's job; observability is decorative.
 */
object SentryFgsBridge {
    @Volatile
    private var initialized: Boolean = false

    /** Idempotent. Caller must pass a non-null `SentryConfig`; skip the call
     *  entirely when `loadFromManifest` returns null. */
    @JvmStatic
    fun init(context: Context, config: SentryConfig) {
        if (initialized) return
        try {
            // Parse once here rather than in the event processor on every capture.
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
                options.dsn = config.dsn
                options.environment = config.environment
                options.release = config.release
                options.sampleRate = config.sampleRate ?: 1.0
                options.tracesSampleRate = config.tracesSampleRate ?: 0.0
                // SDK no-ops Sentry.logger().* when isEnabled=false so helpers can route unconditionally.
                options.logs.isEnabled = config.enableLogs == true
                options.setTag(SentryTags.PROC, SentryTags.PROC_FGS)
                options.setTag(SentryTags.LAYER, SentryTags.LAYER_NATIVE)
                // Mirrors the RN-side `comapeo.rn` global tag. event.modules is
                // skipped (sentry-java's setter is package-private).
                config.moduleVersion?.let { options.setTag("comapeo.rn", it) }
                // Normalise `device.family` to "Android". sentry-android's
                // ContextUtils.getFamily() returns `Build.MODEL.split(" ")[0]`
                // (so "Google" on a Pixel/emulator); the main-process events
                // — captured via @sentry/react-native, which doesn't fetch a
                // device.family from native — surface as "Android" in
                // Sentry's UI via server-side derivation from `os.name`. Set
                // it explicitly here so FGS-captured spans like
                // `comapeo.boot` match the main-process value rather than
                // splitting the dashboard.
                options.addEventProcessor(NormalizeDeviceFamilyProcessor)
            }

            // SentryOptions has no "set context at init" hook; ride a configureScope after init.
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

    /** Level values: `info` / `warning` / `error` / `fatal` / `debug`. Unknown → `info`. */
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

    /** Forward to Sentry's structured-log pipeline. SDK silently drops when
     *  `options.logs.isEnabled = false`, so callers don't need their own gate. */
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
     * Returns an opaque handle (`null` pre-init). Pass to [startBootSpan] / [finishSpan].
     * Opaque `Any?` keeps io.sentry.* out of the caller's bytecode.
     *
     * `TracesSamplingDecision(true, 1.0)` overrides `tracesSampleRate` so the boot
     * transaction lands on the wire even at `tracesSampleRate=0.0`.
     *
     * @param startElapsedRealtime SystemClock.elapsedRealtime to backdate to; `null` → now.
     * @param kind `boot.kind` tag value (`user-foreground` / `system-restart`); `null` skips it.
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
     * `op = "boot.<phase>"` — sentry-java has no separate span.name; Discover
     * renders span.name = op. Filter `op:boot.*`. Phase taxonomy: docs/ARCHITECTURE.md.
     *
     * @param startElapsedRealtime backdate to this SystemClock.elapsedRealtime; `null` → now.
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
                // 3-arg overload (op, desc, SentryDate) — the SpanOptions overload in
                // sentry-java 8.32 overwrites startTimestamp before Span reads it.
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
     * Distributed-trace headers — forwarded to Node via `--sentryTrace`/`--sentryBaggage`
     * so Node-side spans nest under the FGS `comapeo.boot` transaction. Accepts the
     * transaction or any child span. `baggage` is null when no DSC.
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
     * Pass a `@sentry/node` JSON event to sentry-android via `SentryEvent.Deserializer`
     * + `Sentry.captureEvent`. Native scope (device/OS/app/user/native breadcrumbs) is
     * merged at capture; offline transport is inherited.
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
     * Pass a base64-encoded `@sentry/node` envelope (transactions, sessions, …) through
     * sentry-android's hybrid-SDK entrypoint (rate-limit + offline-queue + native-crash
     * cache). Native scope is NOT applied — see ControlFrame.SentryEnvelope. `false` =
     * non-hardCrash path (no fresh session), matching @sentry/react-native.
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

    /** Synchronously flush queued events. Call before `Process.killProcess` so a
     *  shutdown-timeout capture isn't dropped along with the process. */
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
     * Test-only — flip the local gate without calling `SentryAndroid.init` (it needs
     * `SystemClock`, unmocked on the JVM unit-test classpath). Tests set up the hub via
     * the cross-platform `Sentry.init(SentryOptions)` instead.
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
        // No longAttribute factory; `named` avoids the precision loss of toInt().
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
     * elapsedRealtime (monotonic) → wall-clock SentryDate. `nanos` must match what
     * `System.nanoTime()` would have read at the backdated moment — sentry-java
     * computes end via `(end.nanos - start.nanos)` on top of start's wall-clock.
     * Passing `0` yields a far-future end on long-uptime devices, which Sentry rejects.
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

/**
 * Forces `device.family = "Android"` on every event sentry-android emits
 * from this process. See the comment at the addEventProcessor callsite in
 * [SentryFgsBridge.init] for the rationale (cross-process consistency
 * with the main-process @sentry/react-native value).
 */
internal object NormalizeDeviceFamilyProcessor : EventProcessor {
    override fun process(event: SentryEvent, hint: Hint): SentryEvent? {
        normalize(event)
        return event
    }

    override fun process(transaction: SentryTransaction, hint: Hint): SentryTransaction? {
        normalize(transaction)
        return transaction
    }

    private fun normalize(event: SentryBaseEvent) {
        event.contexts.device?.family = "Android"
    }
}
