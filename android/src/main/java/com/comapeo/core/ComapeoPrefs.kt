package com.comapeo.core

import android.content.Context
import androidx.core.content.edit
import java.io.File

/**
 * Persistent storage for Sentry-related user preferences. Snapshot-at-boot:
 * each process reads on its own cold start, so toggle changes only take effect
 * after the next launch. Flipping a toggle to `false` also wipes the on-disk
 * Sentry envelope cache so events queued in the current session never ship.
 *
 * Constructor takes pure read/write lambdas to keep tests free of
 * `SharedPreferences` (unmocked on the JVM unit-test classpath). [open] is
 * the production constructor and runs the one-shot key migration.
 */
internal class ComapeoPrefs(
    private val readBool: (String) -> Boolean?,
    private val writeBool: (String, Boolean) -> Unit,
    private val readLong: (String) -> Long?,
    private val writeLong: (String, Long) -> Unit,
    private val removeKey: (String) -> Unit,
    private val defaults: Defaults,
    /** Wall clock; injectable so 24h-auto-off tests don't depend on real time. */
    private val now: () -> Long = { System.currentTimeMillis() },
) {
    data class Defaults(
        val diagnosticsEnabled: Boolean,
        val applicationUsageData: Boolean,
        val debug: Boolean,
    )

    fun readDiagnosticsEnabled(): Boolean =
        readBool(KEY_DIAGNOSTICS_ENABLED) ?: defaults.diagnosticsEnabled

    fun readApplicationUsageData(): Boolean =
        readBool(KEY_APPLICATION_USAGE_DATA) ?: defaults.applicationUsageData

    /**
     * Read the `debug` toggle, applying the §11.5 24h auto-off: if debug
     * was switched on more than [DEBUG_MAX_AGE_MS] ago, flip it off, clear
     * the timestamp, queue a `comapeo.debug.auto_disabled` breadcrumb, and
     * return `false`. A `debug=true` cell with no timestamp (older install)
     * is treated as "enabled now" and stamped on first read.
     */
    fun readDebugEnabled(): Boolean {
        val stored = readBool(KEY_DEBUG) ?: defaults.debug
        if (!stored) return false
        val enabledAt = readLong(KEY_DEBUG_ENABLED_AT_MS)
        if (enabledAt == null) {
            // No timestamp (pre-Phase-11 cell): start the clock cleanly.
            writeLong(KEY_DEBUG_ENABLED_AT_MS, now())
            return true
        }
        if (now() - enabledAt > DEBUG_MAX_AGE_MS) {
            writeBool(KEY_DEBUG, false)
            removeKey(KEY_DEBUG_ENABLED_AT_MS)
            DebugAutoOff.queueBreadcrumb()
            return false
        }
        return true
    }

    fun writeDiagnosticsEnabled(value: Boolean) {
        writeBool(KEY_DIAGNOSTICS_ENABLED, value)
    }

    fun writeApplicationUsageData(value: Boolean) {
        writeBool(KEY_APPLICATION_USAGE_DATA, value)
    }

    /**
     * Write `debug`, stamping (true) or clearing (false) the enable
     * timestamp synchronously so the 24h window starts/stops with the
     * value. Re-writing `true` refreshes the window (§11.5).
     */
    fun writeDebugEnabled(value: Boolean) {
        writeBool(KEY_DEBUG, value)
        if (value) {
            writeLong(KEY_DEBUG_ENABLED_AT_MS, now())
        } else {
            removeKey(KEY_DEBUG_ENABLED_AT_MS)
        }
    }

    companion object {
        const val PREFS_NAME = "com.comapeo.core.prefs"
        const val KEY_DIAGNOSTICS_ENABLED = "sentry.diagnosticsEnabled"
        const val KEY_APPLICATION_USAGE_DATA = "sentry.applicationUsageData"

        /** Deprecated pre-Phase-11 key, migrated to [KEY_APPLICATION_USAGE_DATA]. */
        const val KEY_CAPTURE_APPLICATION_DATA = "sentry.captureApplicationData"
        const val KEY_DEBUG = "sentry.debug"
        const val KEY_DEBUG_ENABLED_AT_MS = "sentry.debugEnabledAtMs"

        const val DEFAULT_DIAGNOSTICS_ENABLED = true
        const val DEFAULT_APPLICATION_USAGE_DATA = false
        const val DEFAULT_DEBUG = false

        /** 24h in milliseconds (§11.5). */
        const val DEBUG_MAX_AGE_MS = 24L * 60 * 60 * 1000

        /**
         * One-shot rename migration (§11.7): if the old
         * `captureApplicationData` key is present and the new
         * `applicationUsageData` key is absent, copy the value across and
         * delete the old key. Idempotent — runs once because it deletes its
         * own input. Pure-lambda form so it's unit-testable without
         * `SharedPreferences`.
         */
        @JvmStatic
        fun migrateLegacyKeys(
            readBool: (String) -> Boolean?,
            writeBool: (String, Boolean) -> Unit,
            removeKey: (String) -> Unit,
        ) {
            val legacy = readBool(KEY_CAPTURE_APPLICATION_DATA) ?: return
            if (readBool(KEY_APPLICATION_USAGE_DATA) == null) {
                writeBool(KEY_APPLICATION_USAGE_DATA, legacy)
            }
            removeKey(KEY_CAPTURE_APPLICATION_DATA)
        }

        /**
         * `commit = true` (not `apply`) so a subsequent [wipeSentryOutbox] is
         * guaranteed to see a durable `false` on disk. Callers run from
         * AsyncFunction coroutines so the sync cost is acceptable.
         */
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
            val readBool: (String) -> Boolean? =
                { key -> if (sp.contains(key)) sp.getBoolean(key, false) else null }
            val writeBool: (String, Boolean) -> Unit =
                { key, value -> sp.edit(commit = true) { putBoolean(key, value) } }
            val readLong: (String) -> Long? =
                { key -> if (sp.contains(key)) sp.getLong(key, 0L) else null }
            val writeLong: (String, Long) -> Unit =
                { key, value -> sp.edit(commit = true) { putLong(key, value) } }
            val removeKey: (String) -> Unit =
                { key -> sp.edit(commit = true) { remove(key) } }

            migrateLegacyKeys(readBool, writeBool, removeKey)

            return ComapeoPrefs(
                readBool = readBool,
                writeBool = writeBool,
                readLong = readLong,
                writeLong = writeLong,
                removeKey = removeKey,
                defaults = defaults,
            )
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
}

/**
 * Holds the `comapeo.debug.auto_disabled` breadcrumb queued by the 24h
 * auto-off (§11.5). [ComapeoPrefs.readDebugEnabled] runs before
 * `Sentry.init`, so the breadcrumb can't be added directly; it's drained
 * by [SentryFgsBridge.init] / RN init once the SDK is up.
 *
 * Known gap: the main app process and the `:ComapeoCore` FGS process are
 * separate JVMs with separate `DebugAutoOff` statics. On the common
 * cold-start ordering the main-process `sentryPreferences` read
 * ([ComapeoCoreModule]) can win the 24h flip; the FGS read then sees
 * `debug` already false and is a no-op, and the main process has no
 * native-side drain — so the crumb queued there is currently dropped.
 * The auto-off behaviour itself is unaffected; only the timeline marker
 * is lost. Delivering it would need cross-process plumbing (expose the
 * pending flag to JS and drain in the RN `initSentry` path).
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
