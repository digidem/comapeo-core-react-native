package com.comapeo.core

import android.content.Context
import android.util.Log

/**
 * Guarded entry point to the Sentry-Android SDK from the
 * `:ComapeoCore` FGS process.
 *
 * The Gradle dep on `io.sentry:sentry-android-core` is `compileOnly`;
 * runtime classes are expected to come transitively from the host's
 * `@sentry/react-native`. The `Class.forName` probe in [isEnabled]
 * (with `initialize=false`) gates every public method, so consumers
 * without sentry-android on the runtime classpath get clean no-ops
 * instead of `NoClassDefFoundError`.
 *
 * The Guard / Impl split keeps every `io.sentry.*` reference inside
 * [SentryFgsBridgeImpl]; this file MUST stay free of them so the
 * verifier doesn't load Impl on a Sentry-less classpath.
 *
 * The FGS process needs its own SDK init because Android creates a
 * fresh `Application` per process — the host's `SentryAndroid.init`
 * runs in `MainApplication.onCreate` and never reaches `:ComapeoCore`.
 */
object SentryFgsBridge {
    @Volatile
    private var enabled: Boolean? = null

    @Volatile
    private var initialized: Boolean = false

    /**
     * `initialize=false` so the probe doesn't run `SentryAndroid`'s
     * static initialiser, which calls `android.os.SystemClock` —
     * unmocked on the JVM unit-test classpath.
     */
    @JvmStatic
    fun isEnabled(): Boolean {
        val cached = enabled
        if (cached != null) return cached
        val present = try {
            Class.forName(
                "io.sentry.android.core.SentryAndroid",
                false,
                SentryFgsBridge::class.java.classLoader,
            )
            true
        } catch (_: ClassNotFoundException) {
            false
        }
        enabled = present
        return present
    }

    /**
     * Idempotent. Caller must pass a non-null `SentryConfig` —
     * `SentryConfig.loadFromManifest` returns null when no DSN is
     * present, in which case don't call this method at all.
     */
    @JvmStatic
    fun init(context: Context, config: SentryConfig) {
        if (initialized) return
        if (!isEnabled()) {
            Log.i(TAG, "sentry-android not on classpath; FGS-process Sentry off")
            return
        }
        try {
            SentryFgsBridgeImpl.init(context, config)
            initialized = true
        } catch (t: Throwable) {
            // Observability is decorative; the FGS's job is to keep
            // nodejs-mobile alive — never let a Sentry init failure
            // take the process down.
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
            SentryFgsBridgeImpl.addBreadcrumb(category, message, level, data)
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
            SentryFgsBridgeImpl.captureException(throwable, tags)
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
            SentryFgsBridgeImpl.captureMessage(message, level, tags)
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
            SentryFgsBridgeImpl.log(level, message, attributes)
        } catch (t: Throwable) {
            Log.w(TAG, "log($level) threw", t)
        }
    }

    /**
     * Returns an opaque handle (`null` when disabled). Pass back to
     * [startBootSpan] / [finishSpan]. Opaque type keeps `io.sentry.*`
     * out of the consumer's bytecode.
     *
     * @param startElapsedRealtime `SystemClock.elapsedRealtime()` value
     *   to backdate the transaction start to. `null` → start now.
     * @param kind Value for the `boot.kind` tag — `user-foreground`
     *   when the activity initiated the start, `system-restart` when
     *   Android brought the FGS back without an intent. `null` skips
     *   the tag (test convenience).
     */
    @JvmStatic
    @JvmOverloads
    fun startBootTransaction(
        startElapsedRealtime: Long? = null,
        kind: String? = null,
    ): Any? {
        if (!initialized) return null
        return try {
            SentryFgsBridgeImpl.startBootTransaction(startElapsedRealtime, kind)
        } catch (t: Throwable) {
            Log.w(TAG, "startBootTransaction threw", t)
            null
        }
    }

    /**
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
            SentryFgsBridgeImpl.startBootSpan(transaction, phase, startElapsedRealtime)
        } catch (t: Throwable) {
            Log.w(TAG, "startBootSpan($phase) threw", t)
            null
        }
    }

    /**
     * Distributed-trace headers for the supplied transaction. Used by
     * `NodeJSService` to forward the FGS-side `comapeo.boot` context
     * to Node via `--sentryTrace`/`--sentryBaggage` argv so Node-side
     * spans land as children of the same transaction.
     */
    @JvmStatic
    fun getTraceData(transaction: Any?): Pair<String, String?>? {
        if (!initialized || transaction == null) return null
        return try {
            SentryFgsBridgeImpl.getTraceData(transaction)
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
     *
     * Decode + capture are wrapped in a single try/catch: a malformed
     * payload from a misbehaving backend must not take the FGS down.
     */
    @JvmStatic
    fun captureEventJson(payloadJson: String) {
        if (!initialized) return
        try {
            SentryFgsBridgeImpl.captureEventJson(payloadJson)
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
     * Decoding and capture are wrapped in a single try/catch: a malformed
     * envelope from a misbehaving backend (truncated bytes, bad base64,
     * wrong magic header) must not take the FGS down.
     */
    @JvmStatic
    fun captureEnvelopeBase64(data: String) {
        if (!initialized) return
        try {
            SentryFgsBridgeImpl.captureEnvelopeBase64(data)
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
            SentryFgsBridgeImpl.finishSpan(handle, status)
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
            SentryFgsBridgeImpl.setSpanData(handle, key, value)
        } catch (t: Throwable) {
            Log.w(TAG, "setSpanData($key) threw", t)
        }
    }

    /**
     * Synchronously flush queued events. Call before
     * `Process.killProcess` (FGS shutdown timeout) so a "stop
     * timeout" capture isn't dropped along with the process. No-op
     * when sentry-android isn't on the classpath or the bridge
     * never initialised.
     */
    @JvmStatic
    fun flush(timeoutMillis: Long) {
        if (!initialized) return
        try {
            SentryFgsBridgeImpl.flush(timeoutMillis)
        } catch (t: Throwable) {
            Log.w(TAG, "flush threw", t)
        }
    }

    /** Test-only — reset the probe cache and init flag. */
    @JvmStatic
    internal fun resetForTests() {
        enabled = null
        initialized = false
    }

    private const val TAG = "ComapeoCore.Sentry"
}
