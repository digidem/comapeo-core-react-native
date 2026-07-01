package com.comapeo.core

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import java.io.File

/**
 * Persistent storage for Sentry-related user preferences. Snapshot-at-boot:
 * each process reads on its own cold start, so toggle changes only take effect
 * after the next launch. Flipping a toggle to `false` also wipes the on-disk
 * Sentry envelope cache so events queued in the current session never ship.
 *
 * Persistence goes through a [Store] so unit tests can back it with a plain
 * map instead of a real `SharedPreferences` (unmocked on the JVM unit-test
 * classpath). [open] is the production constructor.
 */
internal class ComapeoPrefs(
    private val store: Store,
    private val defaults: Defaults,
    /** Wall clock; injectable so the debug-auto-off tests don't depend on real time. */
    private val now: () -> Long = { System.currentTimeMillis() },
) {
    /**
     * Minimal persistence surface. `null` from a getter means "key absent"
     * (so the caller falls back to a default). Production wraps
     * `SharedPreferences`; tests use an in-memory map.
     */
    internal interface Store {
        fun getBoolean(key: String): Boolean?
        fun putBoolean(key: String, value: Boolean)
        fun getLong(key: String): Long?
        fun putLong(key: String, value: Long)
        fun remove(key: String)
    }

    data class Defaults(
        val diagnosticsEnabled: Boolean,
        val applicationUsageData: Boolean,
        val debug: Boolean,
    )

    fun readDiagnosticsEnabled(): Boolean =
        store.getBoolean(KEY_DIAGNOSTICS_ENABLED) ?: defaults.diagnosticsEnabled

    fun writeDiagnosticsEnabled(value: Boolean) {
        store.putBoolean(KEY_DIAGNOSTICS_ENABLED, value)
    }

    fun readApplicationUsageData(): Boolean =
        store.getBoolean(KEY_APPLICATION_USAGE_DATA) ?: defaults.applicationUsageData

    fun writeApplicationUsageData(value: Boolean) {
        store.putBoolean(KEY_APPLICATION_USAGE_DATA, value)
    }

    /**
     * Read the `debug` toggle, applying the [DEBUG_MAX_AGE_MS] auto-off: if
     * debug was switched on longer ago than that, flip it off, clear the
     * timestamp, queue a `comapeo.debug.auto_disabled` breadcrumb, and return
     * `false`. A `debug=true` cell with no timestamp (e.g. enabled via the
     * configured default) is treated as "enabled now" and stamped on first read.
     *
     * The window is wall-clock based (it must survive process restarts), so a
     * backward clock change is treated conservatively: an enable timestamp in
     * the future expires debug rather than extending it. This is a best-effort
     * privacy window on the user's own device, not a security boundary.
     */
    fun readDebugEnabled(): Boolean {
        val stored = store.getBoolean(KEY_DEBUG) ?: defaults.debug
        if (!stored) return false
        val enabledAt = store.getLong(KEY_DEBUG_ENABLED_AT_MS)
        if (enabledAt == null) {
            // No recorded start (e.g. enabled via the default): start the clock.
            store.putLong(KEY_DEBUG_ENABLED_AT_MS, now())
            return true
        }
        val age = now() - enabledAt
        if (age < 0 || age > DEBUG_MAX_AGE_MS) {
            store.putBoolean(KEY_DEBUG, false)
            store.remove(KEY_DEBUG_ENABLED_AT_MS)
            DebugAutoOff.queueBreadcrumb()
            return false
        }
        return true
    }

    /**
     * Write `debug`, stamping (true) or clearing (false) the enable timestamp
     * synchronously so the window starts/stops with the value. Re-writing
     * `true` refreshes the window.
     */
    fun writeDebugEnabled(value: Boolean) {
        store.putBoolean(KEY_DEBUG, value)
        if (value) {
            store.putLong(KEY_DEBUG_ENABLED_AT_MS, now())
        } else {
            store.remove(KEY_DEBUG_ENABLED_AT_MS)
        }
    }

    companion object {
        const val PREFS_NAME = "com.comapeo.core.prefs"
        const val KEY_DIAGNOSTICS_ENABLED = "sentry.diagnosticsEnabled"
        const val KEY_APPLICATION_USAGE_DATA = "sentry.applicationUsageData"
        const val KEY_DEBUG = "sentry.debug"
        const val KEY_DEBUG_ENABLED_AT_MS = "sentry.debugEnabledAtMs"

        const val DEFAULT_DIAGNOSTICS_ENABLED = true
        const val DEFAULT_APPLICATION_USAGE_DATA = false
        const val DEFAULT_DEBUG = false

        /** 72h in milliseconds — debug mode auto-disables this long after enable. */
        const val DEBUG_MAX_AGE_MS = 72L * 60 * 60 * 1000

        @JvmStatic
        fun open(context: Context): ComapeoPrefs {
            val sentryConfig = SentryConfig.loadFromManifest(context)
            val defaults = Defaults(
                diagnosticsEnabled = sentryConfig?.diagnosticsEnabledDefault
                    ?: DEFAULT_DIAGNOSTICS_ENABLED,
                applicationUsageData = sentryConfig?.applicationUsageDataDefault
                    ?: DEFAULT_APPLICATION_USAGE_DATA,
                debug = sentryConfig?.debugDefault ?: DEFAULT_DEBUG,
            )
            val sp = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            return ComapeoPrefs(SharedPrefsStore(sp), defaults)
        }

        /**
         * Delete sentry-android's on-disk cache (`<cacheDir>/sentry/` — the SDK's
         * documented default) so a `diagnosticsEnabled=false` flip can't ship
         * anything from the current session on next launch. Best-effort: a
         * filesystem error never blocks the privacy opt-out.
         */
        @JvmStatic
        fun wipeSentryOutbox(context: Context) {
            wipeSentryOutboxAt(File(context.cacheDir, "sentry"))
        }

        /** Path-taking variant for unit testing — production uses the [Context] overload. */
        @JvmStatic
        fun wipeSentryOutboxAt(dir: File) {
            try {
                dir.deleteRecursively()
            } catch (_: Throwable) {
                // Swallowed — privacy opt-out is best-effort.
            }
        }
    }

    /**
     * `commit = true` (not `apply`) so a subsequent [wipeSentryOutbox] is
     * guaranteed to see a durable value on disk. Callers run from
     * AsyncFunction coroutines so the sync cost is acceptable.
     */
    private class SharedPrefsStore(private val sp: SharedPreferences) : Store {
        override fun getBoolean(key: String): Boolean? =
            if (sp.contains(key)) sp.getBoolean(key, false) else null

        override fun putBoolean(key: String, value: Boolean) {
            sp.edit(commit = true) { putBoolean(key, value) }
        }

        override fun getLong(key: String): Long? =
            if (sp.contains(key)) sp.getLong(key, 0L) else null

        override fun putLong(key: String, value: Long) {
            sp.edit(commit = true) { putLong(key, value) }
        }

        override fun remove(key: String) {
            sp.edit(commit = true) { remove(key) }
        }
    }
}

/**
 * Holds the `comapeo.debug.auto_disabled` breadcrumb queued by the debug
 * auto-off. [ComapeoPrefs.readDebugEnabled] runs before `Sentry.init`, so the
 * breadcrumb can't be added directly; it's drained by [SentryFgsBridge.init] /
 * RN init once the SDK is up.
 *
 * Known gap: the main app process and the `:ComapeoCore` FGS process are
 * separate JVMs with separate `DebugAutoOff` statics, and only the FGS side
 * drains it. If the main-process read ([ComapeoCoreModule]) performs the
 * auto-off first, the FGS read then sees `debug` already false and queues
 * nothing, so that one breadcrumb is dropped. Consequence is cosmetic — the
 * auto-off itself still happens; only the "when it turned off" timeline marker
 * is missing for that launch. Delivering it would need cross-process plumbing
 * (expose the pending flag to JS and drain it in the RN `initSentry` path).
 */
internal object DebugAutoOff {
    @Volatile
    var pending: Boolean = false
        private set

    fun queueBreadcrumb() {
        pending = true
    }

    /** Consume the pending flag; returns whether a breadcrumb is owed. */
    fun consume(): Boolean {
        val owed = pending
        pending = false
        return owed
    }
}
