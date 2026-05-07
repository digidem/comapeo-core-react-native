package com.comapeo.core

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle

/**
 * Typed view of the AndroidManifest meta-data the Expo plugin
 * (`app.plugin.js`) writes at prebuild time.
 *
 * The meta-data lives on the main `<application>` tag, so both
 * the host UI process and the `:ComapeoCore` FGS process see them
 * — `getApplicationInfo(...).metaData` is shared across processes
 * within the package.
 *
 * `loadFromManifest` returns `null` when the DSN is absent, which
 * is the consumer's signal that Sentry isn't configured.
 */
data class SentryConfig(
    val dsn: String,
    val environment: String,
    val release: String,
    val sampleRate: Double? = null,
    val tracesSampleRate: Double? = null,
    /** Cap on RPC argument bytes captured. Defaults to never capture. */
    val rpcArgsBytes: Int? = null,
    /**
     * Default value for the capture-application-data toggle on
     * fresh installs. `null` → treated as `false`.
     */
    val captureApplicationDataDefault: Boolean? = null,
    /**
     * Opt in to Sentry structured logs (`Sentry.logger.*`). When
     * `true`, the FGS hub initialises with `options.logs.isEnabled
     * = true` and our log helpers route to the Logs UI in addition
     * to the existing logcat / breadcrumb / event pipelines.
     * `null` (or `false`) leaves logs off.
     */
    val enableLogs: Boolean? = null,
) {
    companion object {
        // Manifest meta-data keys. Must stay in sync with
        // app.plugin.js's ANDROID_KEYS.
        const val META_DSN = "com.comapeo.core.sentry.dsn"
        const val META_ENVIRONMENT = "com.comapeo.core.sentry.environment"
        const val META_RELEASE = "com.comapeo.core.sentry.release"
        const val META_SAMPLE_RATE = "com.comapeo.core.sentry.sampleRate"
        const val META_TRACES_SAMPLE_RATE = "com.comapeo.core.sentry.tracesSampleRate"
        const val META_RPC_ARGS_BYTES = "com.comapeo.core.sentry.rpcArgsBytes"
        const val META_CAPTURE_APPLICATION_DATA_DEFAULT =
            "com.comapeo.core.sentry.captureApplicationDataDefault"
        const val META_ENABLE_LOGS = "com.comapeo.core.sentry.enableLogs"

        /** Returns null when no DSN is present (Sentry off). */
        @JvmStatic
        fun loadFromManifest(context: Context): SentryConfig? {
            val meta = readApplicationMetaData(context) ?: return null
            return load({ meta.getString(it) }) { resolveDefaultRelease(context) }
        }

        /**
         * Pure variant for unit-testing. The string-getter avoids
         * mocking `android.os.Bundle` (unmocked on the JVM
         * unit-test classpath); the release producer avoids
         * mocking `PackageManager`.
         */
        @JvmStatic
        fun load(
            metaString: (String) -> String?,
            defaultRelease: () -> String,
        ): SentryConfig? {
            val dsn = metaString(META_DSN) ?: return null
            // The plugin refuses to prebuild without `environment`,
            // but a stale prebuild from before that validation was
            // added would still ship. Log loud and return null
            // (Sentry off) so the host doesn't crash on every cold
            // start; re-prebuilding fixes it.
            val environment = metaString(META_ENVIRONMENT)
            if (environment == null) {
                // System.err rather than android.util.Log.e because
                // the latter is unmocked on the JVM unit-test classpath.
                System.err.println(
                    "[ComapeoCore.SentryConfig] $META_ENVIRONMENT missing " +
                        "from manifest while $META_DSN is set. Re-run " +
                        "`expo prebuild` so the plugin can rewrite the " +
                        "manifest. Sentry disabled until then.",
                )
                return null
            }
            val release = metaString(META_RELEASE) ?: defaultRelease()
            return SentryConfig(
                dsn = dsn,
                environment = environment,
                release = release,
                sampleRate = metaString(META_SAMPLE_RATE)?.toDoubleOrNull(),
                tracesSampleRate = metaString(META_TRACES_SAMPLE_RATE)?.toDoubleOrNull(),
                rpcArgsBytes = metaString(META_RPC_ARGS_BYTES)?.toIntOrNull(),
                captureApplicationDataDefault = metaString(
                    META_CAPTURE_APPLICATION_DATA_DEFAULT,
                )?.toBooleanStrictOrNull(),
                enableLogs = metaString(META_ENABLE_LOGS)?.toBooleanStrictOrNull(),
            )
        }

        private fun readApplicationMetaData(context: Context): Bundle? {
            return try {
                if (Build.VERSION.SDK_INT >= 33) {
                    context.packageManager.getApplicationInfo(
                        context.packageName,
                        PackageManager.ApplicationInfoFlags.of(
                            PackageManager.GET_META_DATA.toLong(),
                        ),
                    ).metaData
                } else {
                    @Suppress("DEPRECATION")
                    context.packageManager.getApplicationInfo(
                        context.packageName,
                        PackageManager.GET_META_DATA,
                    ).metaData
                }
            } catch (_: PackageManager.NameNotFoundException) {
                null
            }
        }

        /**
         * Default release tag: `versionName + "+" + versionCode`.
         * Successive EAS builds of the same marketing version get
         * distinct releases because EAS auto-increments versionCode.
         */
        private fun resolveDefaultRelease(context: Context): String {
            val pkg = if (Build.VERSION.SDK_INT >= 33) {
                context.packageManager.getPackageInfo(
                    context.packageName,
                    PackageManager.PackageInfoFlags.of(0),
                )
            } else {
                @Suppress("DEPRECATION")
                context.packageManager.getPackageInfo(context.packageName, 0)
            }
            val versionName = pkg.versionName ?: "unknown"
            val build: Long = if (Build.VERSION.SDK_INT >= 28) {
                pkg.longVersionCode
            } else {
                @Suppress("DEPRECATION")
                pkg.versionCode.toLong()
            }
            return "$versionName+$build"
        }
    }
}
