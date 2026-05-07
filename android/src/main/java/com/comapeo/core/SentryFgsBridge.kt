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
     * Returns an opaque handle (`null` when disabled). Pass back to
     * [startBootSpan] / [finishSpan]. The opaque type keeps `io.sentry.*`
     * out of the Guard's bytecode.
     */
    @JvmStatic
    fun startBootTransaction(): Any? {
        if (!initialized) return null
        return try {
            SentryFgsBridgeImpl.startBootTransaction()
        } catch (t: Throwable) {
            Log.w(TAG, "startBootTransaction threw", t)
            null
        }
    }

    @JvmStatic
    fun startBootSpan(transaction: Any?, phase: String): Any? {
        if (!initialized || transaction == null) return null
        return try {
            SentryFgsBridgeImpl.startBootSpan(transaction, phase)
        } catch (t: Throwable) {
            Log.w(TAG, "startBootSpan($phase) threw", t)
            null
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

    /** Test-only — reset the probe cache and init flag. */
    @JvmStatic
    internal fun resetForTests() {
        enabled = null
        initialized = false
    }

    private const val TAG = "ComapeoCore.Sentry"
}
