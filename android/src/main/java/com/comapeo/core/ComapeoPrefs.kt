package com.comapeo.core

import android.content.Context
import androidx.core.content.edit
import java.io.File

/**
 * Persistent storage for sentry-related user preferences. Snapshot-
 * at-boot semantics: each process reads on its own cold start, so
 * toggle changes only take effect after the next launch. Toggle-flip
 * to `false` also wipes the on-disk Sentry envelope cache so any
 * events the current session queued never reach the wire.
 *
 * Prefs file name is shared with future callers — Phase 6's exit-
 * reason high-water timestamps land in the same file under their
 * own keys (`*.exit_reasons.last_seen_ms`, `*.backgrounded_at_wall_ms`),
 * so picking the name here and reserving it avoids a rename later.
 *
 * Constructor takes pure read/write lambdas to keep tests free of
 * `android.content.SharedPreferences` (unmocked on the JVM unit-test
 * classpath). [open] is the production constructor.
 */
internal class ComapeoPrefs(
    private val readBool: (String) -> Boolean?,
    private val writeBool: (String, Boolean) -> Unit,
    private val defaults: Defaults,
) {
    data class Defaults(
        val diagnosticsEnabled: Boolean,
        val captureApplicationData: Boolean,
    )

    /** User's saved value, or the plugin/baked default if absent. */
    fun readDiagnosticsEnabled(): Boolean =
        readBool(KEY_DIAGNOSTICS_ENABLED) ?: defaults.diagnosticsEnabled

    /** User's saved value, or the plugin/baked default if absent. */
    fun readCaptureApplicationData(): Boolean =
        readBool(KEY_CAPTURE_APPLICATION_DATA) ?: defaults.captureApplicationData

    fun writeDiagnosticsEnabled(value: Boolean) {
        writeBool(KEY_DIAGNOSTICS_ENABLED, value)
    }

    fun writeCaptureApplicationData(value: Boolean) {
        writeBool(KEY_CAPTURE_APPLICATION_DATA, value)
    }

    companion object {
        const val PREFS_NAME = "com.comapeo.core.prefs"
        const val KEY_DIAGNOSTICS_ENABLED = "sentry.diagnosticsEnabled"
        const val KEY_CAPTURE_APPLICATION_DATA = "sentry.captureApplicationData"

        /** Diagnostics default-default — privacy model treats baseline error visibility as on. */
        const val DEFAULT_DIAGNOSTICS_ENABLED = true

        /** Capture-application-data default-default — off until user opts in. */
        const val DEFAULT_CAPTURE_APPLICATION_DATA = false

        /**
         * Construct using `SharedPreferences` and the manifest-supplied
         * defaults (from `SentryConfig.loadFromManifest`). When the
         * plugin didn't ship a default, falls back to [DEFAULT_DIAGNOSTICS_ENABLED]
         * / [DEFAULT_CAPTURE_APPLICATION_DATA].
         *
         * `commit = true` on the writes (rather than `apply()`) so a
         * subsequent [wipeSentryOutbox] is guaranteed to see a durable
         * `false` on disk — callers run this from `AsyncFunction`
         * coroutines, never on the JS thread, so the sync cost is
         * acceptable.
         */
        @JvmStatic
        fun open(context: Context): ComapeoPrefs {
            val sentryConfig = SentryConfig.loadFromManifest(context)
            val defaults = Defaults(
                diagnosticsEnabled = sentryConfig?.diagnosticsEnabledDefault
                    ?: DEFAULT_DIAGNOSTICS_ENABLED,
                captureApplicationData = sentryConfig?.captureApplicationDataDefault
                    ?: DEFAULT_CAPTURE_APPLICATION_DATA,
            )
            val sp = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            return ComapeoPrefs(
                readBool = { key -> if (sp.contains(key)) sp.getBoolean(key, false) else null },
                writeBool = { key, value -> sp.edit(commit = true) { putBoolean(key, value) } },
                defaults = defaults,
            )
        }

        /**
         * Recursively delete sentry-android's on-disk cache root.
         * Path: `<cacheDir>/sentry/` — sentry-android's documented
         * default (`AndroidOptionsInitializer.getCacheDir`). Wipes
         * pending envelopes, sessions, and scope state in one shot
         * so a `diagnosticsEnabled=false` flip can't ship anything
         * from the current session on next launch.
         *
         * Best-effort: a filesystem error never blocks the privacy
         * opt-out. The worst case is the cache survives one more
         * boot, but that boot won't init Sentry (diagnostics is
         * off), so nothing will read it.
         *
         * The FGS process keeps capturing in-memory until it
         * restarts; this is documented restart-to-activate
         * behaviour. The wipe nukes whatever's already on disk at
         * write time.
         */
        @JvmStatic
        fun wipeSentryOutbox(context: Context) {
            wipeSentryOutboxAt(File(context.cacheDir, "sentry"))
        }

        /**
         * Path-taking variant exposed for unit testing — production
         * code uses the [Context]-taking overload above. Kept on
         * the same path constant (`<parent>/sentry/`) so a
         * regression that renames the subdir is caught by the
         * caller test, not just this method's test.
         */
        @JvmStatic
        fun wipeSentryOutboxAt(dir: File) {
            try {
                dir.deleteRecursively()
            } catch (_: Throwable) {
                // Swallowed — see KDoc on the Context overload.
            }
        }
    }
}
