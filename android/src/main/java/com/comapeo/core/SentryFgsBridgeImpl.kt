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
            // `comapeo.rn` tag mirrors the RN-side `initSentry`'s
            // global-scope tag (see `src/sentry.ts`). Applied here on
            // the FGS-side SDK so FGS-emitted captures + Node-forwarded
            // events both carry it; the host's main-process
            // `@sentry/react-native` covers the RN side. The RN-side
            // also adds `@comapeo/core-react-native` to `event.modules`,
            // which we skip here: `SentryEvent.getModules()` is
            // package-private in sentry-java so we can't read +
            // merge, and overwriting would clobber sentry-android's
            // `ModulesLoader` output.
            config.moduleVersion?.let { options.setTag("comapeo.rn", it) }
        }

        // `comapeoBackend` context — sentry-java's `SentryOptions`
        // doesn't expose a "set context on global scope at init"
        // hook, so it has to ride a `configureScope` call after init.
        // `IScope.setContexts(key, value)` — plural method name — is
        // the actual API. The `Object` overload accepts our Map.
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

    /**
     * Span op uses the full `"boot.<phase>"` form rather than just
     * `"boot"` — sentry-java's child-span wire format has no separate
     * "name" field, so Discover renders `span.name = op`. Filter via
     * the wildcard `op:boot.*` in Discover to catch them all (Node-
     * side spans match too: they use `name: "boot.<phase>"`, `op:
     * "boot.<phase>"`).
     *
     * Phase identifiers — kept here for maintainers, not on the wire:
     *   - `fgs-launch`   — startForegroundService → NodeJSService.start
     *   - `node-spawn`   — startNodeWithArguments → control "started"
     *   - `rootkey-load` — RootKeyStore.loadOrInitialize
     *   - `init-frame`   — init frame sent → control "ready"
     */
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
            // Use the `(operation, description, SentryDate)` overload
            // rather than the `(operation, description, SpanOptions)`
            // one. In sentry-java 8.32.0, the SpanOptions path routes
            // through `SentryTracer.startChild(..., timestamp, ...,
            // spanOptions)` which calls `spanOptions.setStartTimestamp(timestamp)`
            // with `timestamp = null`, *overwriting* our backdated
            // `SpanOptions.startTimestamp` before the `Span` constructor
            // reads it. The 3-arg `SentryDate` overload threads the
            // value through `timestamp` so the setStartTimestamp call
            // installs the right value.
            return transaction.startChild(
                op,
                op,
                elapsedRealtimeToSentryDate(startElapsedRealtime),
            )
        }
        return transaction.startChild(op, op)
    }

    /**
     * Returns `(sentryTrace, baggage)` for the given span or transaction
     * — the W3C-compatible headers Node passes through `continueTrace`
     * to make Node-side spans children of the FGS-side parent. Accepts
     * `ISpan` (which both `ITransaction` and `Span` implement) because
     * `NodeJSService` forwards the `node-spawn` span's trace header
     * rather than the transaction's, so Node-side boot spans nest
     * under `boot.node-spawn` (see commit e3b233d9). `baggage` may be
     * `null` when the trace has no DSC info.
     */
    fun getTraceData(handle: Any): Pair<String, String?> {
        require(handle is ISpan) {
            "handle must be ISpan, got ${handle.javaClass.name}"
        }
        val trace = handle.toSentryTrace().value
        val baggage = handle.toBaggageHeader(emptyList())?.value
        return trace to baggage
    }

    /**
     * Converts a `SystemClock.elapsedRealtime()` reading to a wall-clock
     * `SentryDate`. We use elapsedRealtime (monotonic) as the timestamp
     * source across the boot pipeline — system clock can jump from NTP
     * sync mid-boot — and translate to wall-clock here for Sentry.
     *
     * The `nanos` field is critical: sentry-java computes a span's end
     * timestamp via `start.nanoTimestamp() + (end.nanos - start.nanos)`
     * (see `SentryNanotimeDate.nanotimeDiff`). When `transaction.finish()`
     * runs, the SDK fills `end.nanos = System.nanoTime()` — which on
     * Android counts from boot, so it's huge (5×10¹⁴ for a 5-day uptime).
     * Passing `0` here would make the SDK compute a "duration" of the
     * entire system uptime and produce an end timestamp days in the
     * future, which Sentry's ingestion rejects. Anchor `nanos` at
     * "what `System.nanoTime()` would have read at the back-dated
     * moment" so the diff math stays bounded by real elapsed time.
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

    fun flush(timeoutMillis: Long) {
        Sentry.flush(timeoutMillis)
    }

    /**
     * Decodes the JSON-serialised Node event via the public
     * `SentryEvent.Deserializer` and captures through
     * `Sentry.captureEvent`. That path applies the current scope
     * (device, OS, app, user, native breadcrumbs) before the envelope
     * lands in the same on-disk transport the envelope path uses.
     */
    fun captureEventJson(payloadJson: String) {
        val reader = JsonObjectReader(StringReader(payloadJson))
        val event = SentryEvent.Deserializer().deserialize(reader, NoOpLogger.getInstance())
        Sentry.captureEvent(event)
    }

    /**
     * `InternalSentrySdk.captureEnvelope(bytes, maybeStartNewSession)`
     * is the documented hybrid-SDK entrypoint: it parses the envelope,
     * applies rate-limit + offline-queue handling, and writes to the
     * same on-disk envelope cache native crashes use. `false` for the
     * second argument matches `@sentry/react-native`'s non-hardCrash
     * path — we're forwarding a normal capture, not a process-fatal
     * crash, so we don't want a fresh session.
     */
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
