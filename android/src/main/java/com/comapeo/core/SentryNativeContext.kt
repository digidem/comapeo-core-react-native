package com.comapeo.core

import android.content.Context
import android.content.res.Resources
import android.os.Build
import android.os.Environment
import android.os.StatFs
import androidx.core.content.pm.PackageInfoCompat
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import java.util.Locale
import java.util.TimeZone

/**
 * Builds the static-only `sentryContext` blob attached to the init
 * control frame. Backend's loader merges these onto every event via
 * `Sentry.addEventProcessor`, overwriting `nodeContextIntegration`'s
 * Linux-kernel view with the actual user-facing Android values.
 *
 * Only fields that don't change during a session — battery, network,
 * free memory, foreground state etc. live with Phase 5's update frame.
 */
object SentryNativeContext {
    fun build(context: Context): JsonObject {
        val pm = context.packageManager
        @Suppress("DEPRECATION")
        val pkg = if (Build.VERSION.SDK_INT >= 33) {
            pm.getPackageInfo(context.packageName, android.content.pm.PackageManager.PackageInfoFlags.of(0))
        } else {
            pm.getPackageInfo(context.packageName, 0)
        }
        val versionCode = PackageInfoCompat.getLongVersionCode(pkg)
        val metrics = Resources.getSystem().displayMetrics
        val storageStats = runCatching {
            val stat = StatFs(Environment.getDataDirectory().path)
            stat.blockSizeLong * stat.blockCountLong
        }.getOrNull()
        val totalMemoryBytes = runCatching {
            val mi = android.app.ActivityManager.MemoryInfo()
            (context.getSystemService(Context.ACTIVITY_SERVICE) as android.app.ActivityManager)
                .getMemoryInfo(mi)
            mi.totalMem
        }.getOrNull()
        val familyName = Build.PRODUCT
        // Generic / Android Studio AVD fingerprints contain "generic"
        // or "sdk_gphone"; ranger-1 era simulators use "ranchu". This
        // is best-effort — sentry-android does the same fingerprint
        // sniff for `device.simulator`.
        val isSimulator = Build.FINGERPRINT.startsWith("generic") ||
            Build.FINGERPRINT.contains("vbox") ||
            Build.MODEL.contains("Emulator") ||
            Build.MODEL.contains("Android SDK")

        return buildJsonObject {
            putJsonObject("device") {
                put("manufacturer", Build.MANUFACTURER)
                put("brand", Build.BRAND)
                put("model", Build.MODEL)
                put("model_id", Build.DEVICE)
                put("family", familyName)
                put("arch", Build.SUPPORTED_ABIS.firstOrNull() ?: "unknown")
                put("simulator", isSimulator)
                put("processor_count", Runtime.getRuntime().availableProcessors())
                put(
                    "screen_resolution",
                    "${metrics.widthPixels}x${metrics.heightPixels}",
                )
                put("screen_density", metrics.density.toDouble())
                put("screen_dpi", metrics.densityDpi)
                if (totalMemoryBytes != null) put("memory_size", totalMemoryBytes)
                if (storageStats != null) put("storage_size", storageStats)
            }
            putJsonObject("os") {
                put("name", "Android")
                put("version", Build.VERSION.RELEASE)
                put("build", Build.DISPLAY)
                put("kernel_version", System.getProperty("os.version") ?: "unknown")
            }
            putJsonObject("app") {
                put("app_identifier", context.packageName)
                pkg.versionName?.let { put("app_version", it) }
                put("app_build", versionCode.toString())
                // applicationInfo is nullable on API 33+; skip the
                // label rather than risk an NPE on a malformed pkg.
                pkg.applicationInfo?.let {
                    put("app_name", pm.getApplicationLabel(it).toString())
                }
            }
            putJsonObject("culture") {
                put("locale", Locale.getDefault().toLanguageTag())
                put("timezone", TimeZone.getDefault().id)
            }
            putJsonObject("tags") {
                put("os.name", "Android")
                put("device.family", familyName)
                put("device.simulator", isSimulator.toString())
            }
        }
    }
}
