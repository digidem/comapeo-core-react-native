package com.comapeo.core

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle

/**
 * Typed view of the AndroidManifest meta-data the Expo plugin (`app.plugin.js`)
 * writes at prebuild. Meta-data on the `<application>` tag is visible to both
 * the host UI process and the `:ComapeoCore` FGS process.
 *
 * [loadFromManifest] returns null when the DSN is absent — the consumer's
 * signal that Sentry isn't configured.
 */
data class SentryConfig(
    val dsn: String,
    val environment: String,
    val release: String,
    val sampleRate: Double? = null,
    val tracesSampleRate: Double? = null,
    /** Cap on RPC argument bytes captured. Defaults to never capture. */
    val rpcArgsBytes: Int? = null,
    /** Fresh-install default for diagnostics toggle. `null` → `true`. User write wins. */
    val diagnosticsEnabledDefault: Boolean? = null,
    /** Fresh-install default for application-usage-data toggle. `null` → `false`. */
    val applicationUsageDataDefault: Boolean? = null,
    /** Fresh-install default for the `debug` toggle. `null` → `false`. */
    val debugDefault: Boolean? = null,
    /** Opt in to Sentry structured logs (`Sentry.logger.*`). `null` → off. */
    val enableLogs: Boolean? = null,
    /**
     * Module build label `<version>[+git<sha>[-dirty<hash>]]` from `build/version.js`
     * (falls back to package.json when unbuilt). Applied as the `comapeo.rn` scope
     * tag so FGS / Node / RN events all carry matching module identification.
     */
    val moduleVersion: String? = null,
    /**
     * JSON map of bundled-backend dependency versions, filtered to comapeo-owned deps.
     * Applied as the `comapeoBackend` scope context.
     */
    val backendModulesJson: String? = null,
) {
    /**
     * Subset that maps cleanly to `Sentry.init` options on the RN side. Sent to JS
     * as the `sentryConfig` constant; consumers spread into `Sentry.init({...})`.
     */
    fun toSentryInitMap(deviceTags: DeviceTags? = null): Map<String, Any> = buildMap {
        put("dsn", dsn)
        put("environment", environment)
        put("release", release)
        sampleRate?.let { put("sampleRate", it) }
        tracesSampleRate?.let { put("tracesSampleRate", it) }
        enableLogs?.let { put("enableLogs", it) }
        deviceTags?.let {
            put(
                "deviceTags",
                mapOf(
                    "platform" to it.platform,
                    "deviceClass" to it.deviceClass,
                    "osMajor" to it.osMajor,
                ),
            )
        }
    }

    companion object {
        // Manifest meta-data keys — must stay in sync with app.plugin.js's ANDROID_KEYS.
        const val META_DSN = "com.comapeo.core.sentry.dsn"
        const val META_ENVIRONMENT = "com.comapeo.core.sentry.environment"
        const val META_RELEASE = "com.comapeo.core.sentry.release"
        const val META_SAMPLE_RATE = "com.comapeo.core.sentry.sampleRate"
        const val META_TRACES_SAMPLE_RATE = "com.comapeo.core.sentry.tracesSampleRate"
        const val META_RPC_ARGS_BYTES = "com.comapeo.core.sentry.rpcArgsBytes"
        const val META_DIAGNOSTICS_ENABLED_DEFAULT =
            "com.comapeo.core.sentry.diagnosticsEnabledDefault"
        const val META_APPLICATION_USAGE_DATA_DEFAULT =
            "com.comapeo.core.sentry.applicationUsageDataDefault"

        /** Deprecated pre-Phase-11 key; still read for one minor (§11.7). */
        const val META_CAPTURE_APPLICATION_DATA_DEFAULT =
            "com.comapeo.core.sentry.captureApplicationDataDefault"
        const val META_DEBUG_DEFAULT = "com.comapeo.core.sentry.debugDefault"
        const val META_ENABLE_LOGS = "com.comapeo.core.sentry.enableLogs"
        const val META_MODULE_VERSION = "com.comapeo.core.module.version"
        const val META_BACKEND_MODULES = "com.comapeo.core.backend.modules"

        /** Returns null when no DSN is present (Sentry off). */
        @JvmStatic
        fun loadFromManifest(context: Context): SentryConfig? {
            val meta = readApplicationMetaData(context) ?: return null
            // Android's manifest parser coerces `"true"` → Boolean and `"1.0"` → Float
            // before the Bundle sees it; `get(key)?.toString()` preserves the wire value
            // where `getString` would return null for non-string-typed entries.
            return load({ meta.get(it)?.toString() }) { resolveDefaultRelease(context) }
        }

        /**
         * Pure variant for unit testing. The string-getter avoids mocking `Bundle`
         * (unmocked on the JVM unit-test classpath); the release producer avoids
         * mocking `PackageManager`.
         */
        @JvmStatic
        fun load(
            metaString: (String) -> String?,
            defaultRelease: () -> String,
        ): SentryConfig? {
            val dsn = metaString(META_DSN) ?: return null
            val environment = metaString(META_ENVIRONMENT)
            if (environment == null) {
                // Plugin refuses to prebuild without `environment`, but a stale prebuild
                // from before that validation could still ship. Log loud and return null.
                // System.err rather than Log.e — the latter is unmocked on JVM unit tests.
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
                diagnosticsEnabledDefault = metaString(
                    META_DIAGNOSTICS_ENABLED_DEFAULT,
                )?.toBooleanStrictOrNull(),
                // New key wins; fall back to the deprecated key for one minor (§11.7).
                applicationUsageDataDefault = (
                    metaString(META_APPLICATION_USAGE_DATA_DEFAULT)
                        ?: metaString(META_CAPTURE_APPLICATION_DATA_DEFAULT)
                )?.toBooleanStrictOrNull(),
                debugDefault = metaString(META_DEBUG_DEFAULT)?.toBooleanStrictOrNull(),
                enableLogs = metaString(META_ENABLE_LOGS)?.toBooleanStrictOrNull(),
                moduleVersion = metaString(META_MODULE_VERSION),
                backendModulesJson = metaString(META_BACKEND_MODULES),
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
         * Default release tag `versionName+versionCode` — EAS auto-increments
         * versionCode so successive builds of one marketing version still differ.
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
