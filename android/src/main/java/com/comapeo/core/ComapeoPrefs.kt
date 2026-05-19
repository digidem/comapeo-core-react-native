package com.comapeo.core

import android.content.Context
import androidx.core.content.edit
import java.io.File

/**
 * Persistent storage for Sentry-related user preferences. Snapshot-at-boot:
 * each process reads on its own cold start, so toggle changes only take effect
 * after the next launch. Flipping to `false` also wipes the on-disk Sentry
 * envelope cache so events queued in the current session never ship.
 *
 * Constructor takes pure read/write lambdas to keep tests free of
 * `SharedPreferences` (unmocked on the JVM unit-test classpath). [open] is
 * the production constructor.
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

    fun readDiagnosticsEnabled(): Boolean =
        readBool(KEY_DIAGNOSTICS_ENABLED) ?: defaults.diagnosticsEnabled

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
        const val DEFAULT_DIAGNOSTICS_ENABLED = true
        const val DEFAULT_CAPTURE_APPLICATION_DATA = false

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
