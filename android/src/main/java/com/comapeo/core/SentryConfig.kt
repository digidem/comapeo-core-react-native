package com.comapeo.core

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle

/**
 * Phase 2 of the Sentry integration plan
 * (docs/sentry-integration-plan.md §4.1, §4.2). Typed view of the
 * AndroidManifest meta-data the Expo plugin (`app.plugin.js`) writes
 * at prebuild time.
 *
 * The meta-data lives on the manifest's main `<application>` tag, so
 * both the host app's main process AND the `:ComapeoCore` FGS process
 * see them — `PackageManager.getApplicationInfo(...).metaData` is
 * shared across processes within the package.
 *
 * `loadFromManifest` returns `null` when the DSN meta-data is absent,
 * which is the consumer's signal that Sentry was not configured
 * (the plugin omits all entries when invoked without a `sentry`
 * argument, or when not registered at all). Treat null as "Sentry
 * off" — do not init the SDK, do not pass `--sentryDsn` argv flags
 * to the embedded backend (Phase 3).
 *
 * Phase 2 ships the data class and reader; the actual native-side
 * Sentry SDK init in `ComapeoCoreService.onCreate` and the
 * native-side breadcrumb / span / event calls in `NodeJSService` are
 * a Phase 2.5 follow-up because they require adding `io.sentry`
 * Gradle deps that this PR deliberately doesn't touch.
 */
data class SentryConfig(
    val dsn: String,
    val environment: String,
    val release: String,
    val sampleRate: Double? = null,
    val tracesSampleRate: Double? = null,
    /**
     * Cap on RPC argument bytes captured to Sentry. `null` (or 0)
     * means RPC arguments are never captured — the default. Only
     * developer debug builds are expected to set this; see plan
     * §7.4.9 for the never-capture list.
     */
    val rpcArgsBytes: Int? = null,
    /**
     * Per-environment default for the §9 capture-application-data
     * toggle when the user has not yet set it explicitly. `null`
     * means absent → native treats as `false`. Wired via the plugin
     * so a consumer can opt internal/test builds in by default
     * without changing JS code.
     */
    val captureApplicationDataDefault: Boolean? = null,
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

        /**
         * Read the typed config from the host app's manifest. Returns
         * `null` when no DSN is present, which is the documented
         * "Sentry off" state.
         *
         * Throws `IllegalStateException` only when a DSN is present
         * but `environment` is missing — that combination indicates
         * a build misconfiguration the plugin should have refused at
         * prebuild time. Failing loud in that case is preferred to
         * silently degrading; otherwise we'd ship Sentry events with
         * no environment tag and they'd be impossible to filter.
         */
        @JvmStatic
        fun loadFromManifest(context: Context): SentryConfig? {
            val meta = readApplicationMetaData(context) ?: return null
            return load({ meta.getString(it) }) { resolveDefaultRelease(context) }
        }

        /**
         * Pure variant for unit-testing. Takes a string-getter (so
         * tests don't have to mock `android.os.Bundle`, which the
         * JVM unit-test classpath leaves as a "not mocked" stub) and
         * a producer for the `release` fallback (because the JVM
         * unit-test classpath has no real `PackageManager` to read
         * versionName/versionCode from).
         *
         * Returns null when DSN is absent (sentry-off state).
         * Throws `IllegalStateException` when DSN is present but
         * `environment` is missing — see the throws note on
         * [loadFromManifest].
         */
        @JvmStatic
        fun load(
            metaString: (String) -> String?,
            defaultRelease: () -> String,
        ): SentryConfig? {
            val dsn = metaString(META_DSN) ?: return null
            val environment = metaString(META_ENVIRONMENT)
                ?: error(
                    "comapeo: $META_ENVIRONMENT missing from manifest — the " +
                        "Expo plugin should have refused this prebuild. " +
                        "Re-run `expo prebuild` or check app.config.js.",
                )
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
            )
        }

        /**
         * Pulls the `<application>` meta-data Bundle. Returns null on
         * NameNotFoundException — defensive; the host app is always
         * its own package so this should never miss in practice, but
         * a missing manifest is preferable to a crash on cold start.
         */
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
         * Default release tag when the plugin didn't supply one
         * (§4.1): `versionName + "+" + versionCode`. Successive EAS
         * builds of the same marketing version get distinct release
         * strings because EAS auto-increments versionCode.
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
