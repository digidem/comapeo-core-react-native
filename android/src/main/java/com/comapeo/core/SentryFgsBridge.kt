package com.comapeo.core

import android.content.Context
import android.util.Log

/**
 * Phase 2b — guarded entry point to the Sentry-Android SDK from the
 * `:ComapeoCore` FGS process.
 *
 * Two reasons for this guard layer (the impl lives in
 * [SentryFgsBridgeImpl] which freely imports `io.sentry.*`):
 *
 * 1. **Optional runtime classpath.** The Gradle dependency on
 *    `io.sentry:sentry-android-core` is `compileOnly` (see
 *    `android/build.gradle`). Consumers who don't install
 *    `@sentry/react-native` won't have the runtime classes, so a
 *    direct call into `io.sentry.Sentry` from the FGS would fail
 *    class-load with `NoClassDefFoundError`. The cheap
 *    `Class.forName` probe in [isEnabled] gates every public method
 *    so the missing classpath never reaches the verifier.
 *
 * 2. **FGS-process scope, not main-process scope.** The host's
 *    `@sentry/react-native` runs `SentryAndroid.init(...)` in the
 *    main process's `MainApplication.onCreate`. That init never
 *    fires in the `:ComapeoCore` FGS process (Android creates a
 *    fresh `Application` per process). [init] populates the FGS-side
 *    Sentry hub so logcat tail / foreground-state context lands on
 *    captures from this process — see plan §7.4.7.
 *
 * All public methods are no-ops when:
 *   - The Sentry SDK isn't on the runtime classpath (guard miss).
 *   - [init] was never called (DSN absent in manifest, or this is
 *     not the FGS process).
 */
object SentryFgsBridge {
    /**
     * Cached result of the `Class.forName` probe — `null` until the
     * first call, `true`/`false` after that. Avoids paying the probe
     * cost on every breadcrumb / span emit.
     */
    @Volatile
    private var enabled: Boolean? = null

    @Volatile
    private var initialized: Boolean = false

    /**
     * Probes for the Sentry-Android runtime classes. Returns `false`
     * when the consumer didn't install `@sentry/react-native` (or
     * stripped it via R8 / a custom build). Cached after first call.
     *
     * The probe target is a stable public class — `SentryAndroid`
     * itself — so a future SDK bump that renames internal classes
     * doesn't accidentally flip the gate.
     */
    @JvmStatic
    fun isEnabled(): Boolean {
        val cached = enabled
        if (cached != null) return cached
        // `initialize = false` so the probe doesn't run
        // `SentryAndroid`'s `<clinit>` (which on the real device
        // is fine, but on the JVM unit-test classpath calls
        // `android.os.SystemClock.uptimeMillis()` and crashes
        // with "not mocked"). The probe only needs to confirm
        // the symbol resolves; init happens later via
        // `SentryAndroid.init(...)` from the real Android process.
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
     * Initialise the FGS-process Sentry SDK. Idempotent — second call
     * within the same process is silently dropped (sentry-android's
     * own `init` logs a warning in that case but doesn't crash; we
     * short-circuit to keep logs clean).
     *
     * Called from `ComapeoCoreService.onCreate`. Pass the
     * `applicationContext` and the `SentryConfig` produced by
     * `SentryConfig.loadFromManifest(...)`. When that returned `null`
     * (no DSN in manifest), don't call this method at all — there's
     * nothing to init.
     */
    @JvmStatic
    fun init(context: Context, config: SentryConfig) {
        if (initialized) return
        if (!isEnabled()) {
            Log.i(
                TAG,
                "SentryFgsBridge.init: sentry-android not on classpath; FGS-process Sentry off",
            )
            return
        }
        try {
            SentryFgsBridgeImpl.init(context, config)
            initialized = true
        } catch (t: Throwable) {
            // Failing to init Sentry must NOT take the FGS down. The
            // FGS's job is to keep nodejs-mobile alive; observability
            // is decorative compared to that.
            Log.e(TAG, "SentryFgsBridge.init failed; continuing without FGS Sentry", t)
        }
    }

    /**
     * Add a breadcrumb to the FGS-process Sentry scope. Rides on
     * the next event captured from this process. No-op when not
     * initialized.
     *
     * Severity strings are loose ("info" | "warning" | "error" |
     * "fatal" | "debug") — the bridge maps to `SentryLevel`
     * internally. Unknown strings fall back to `INFO`.
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
            // Don't let a Sentry hiccup take the FGS down. Log so
            // debug builds notice the swallowed surprise — a real
            // bug in the bridge or SDK shouldn't be silent.
            Log.w(TAG, "addBreadcrumb($category) threw", t)
        }
    }

    /**
     * Capture an exception on the FGS-process scope. Tags are
     * applied to the event; the FGS-init-set process-level tag
     * `proc:fgs` is already on the scope.
     */
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

    /**
     * Capture a `captureMessage` event. Used for timeout firings
     * (§7.4.4) and other "notable but non-throw" events.
     */
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
     * Start a `comapeo.boot` transaction. Returns an opaque handle
     * (or `null` when disabled) which must be passed back to
     * [finishBootTransaction]. Force 100% sample rate per plan
     * §7.4.2 — boot is once-per-process and high value.
     *
     * The opaque return type is `Any?` rather than `ITransaction?`
     * so callers can stay free of `io.sentry.*` imports — keeping
     * the dependency surface scoped to the impl file.
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

    /** Add a `boot.<phase>` child span on a transaction handle. */
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

    /**
     * Finish a span / transaction handle previously returned by
     * [startBootTransaction] / [startBootSpan]. `status` is `"ok"`,
     * `"internal_error"`, `"deadline_exceeded"`, or `"cancelled"`
     * (mapped to `SpanStatus.*` internally).
     */
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

    // For tests: reset the cached enabled flag and the initialized
    // bit. Production code never calls this; the JVM unit-test
    // classpath uses it to switch Impl on/off between cases.
    @JvmStatic
    internal fun resetForTests() {
        enabled = null
        initialized = false
        try {
            SentryFgsBridgeImpl.resetForTests()
        } catch (_: Throwable) {
        }
    }

    private const val TAG = "ComapeoCore.Sentry"
}
