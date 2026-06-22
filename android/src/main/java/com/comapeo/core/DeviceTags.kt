package com.comapeo.core

import android.app.ActivityManager
import android.content.Context
import android.os.Build

/**
 * Low-cardinality device classification (§11.2.b). Buckets the device
 * into low/mid/high by RAM + CPU cores so a metric like
 * "low-end devices are 4× slower at observation.create" is a dashboard
 * query rather than a 2,000-model cardinality explosion. Computed once
 * at process start and cached on [SentryConfig].
 *
 * Raw model/manufacturer stay on the event/trace scope (native SDK
 * attaches them); only the bucket rides on metrics.
 */
data class DeviceTags(
    val platform: String,
    val deviceClass: String,
    val osMajor: String,
) {
    companion object {
        const val PLATFORM = "android"

        const val CLASS_LOW = "low"
        const val CLASS_MID = "mid"
        const val CLASS_HIGH = "high"

        private const val GB = 1024L * 1024 * 1024

        /**
         * Thresholds (§11.2.b):
         *   low:  < 3 GB RAM OR < 4 cores
         *   mid:  3–6 GB AND 4–6 cores
         *   high: ≥ 6 GB AND ≥ 6 cores
         *
         * A device that's high on one axis but low on the other falls to
         * the lower class — the slow axis dominates perceived perf.
         *
         * @param totalMemBytes `ActivityManager.MemoryInfo.totalMem`.
         * @param cores `Runtime.getRuntime().availableProcessors()`.
         */
        @JvmStatic
        fun classify(totalMemBytes: Long, cores: Int): String {
            // Boundaries are inclusive at the lower edge of each higher band:
            // exactly 3 GB / exactly 4 cores is the floor of `mid`.
            val ramHigh = totalMemBytes >= 6 * GB
            val ramMid = totalMemBytes >= 3 * GB
            val coresHigh = cores >= 6
            val coresMid = cores >= 4
            return when {
                ramHigh && coresHigh -> CLASS_HIGH
                ramMid && coresMid -> CLASS_MID
                else -> CLASS_LOW
            }
        }

        /** `android.<major>` from `Build.VERSION.RELEASE` (§11.2.b). */
        @JvmStatic
        fun osMajor(release: String?): String {
            val major = release?.split(".")?.firstOrNull()?.takeIf { it.isNotEmpty() }
                ?: "0"
            return "$PLATFORM.$major"
        }

        @JvmStatic
        fun compute(context: Context): DeviceTags {
            val activityManager =
                context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
            val memInfo = ActivityManager.MemoryInfo()
            activityManager?.getMemoryInfo(memInfo)
            val cores = Runtime.getRuntime().availableProcessors()
            return DeviceTags(
                platform = PLATFORM,
                deviceClass = classify(memInfo.totalMem, cores),
                osMajor = osMajor(Build.VERSION.RELEASE),
            )
        }
    }
}
