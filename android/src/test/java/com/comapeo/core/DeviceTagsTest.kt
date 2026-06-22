package com.comapeo.core

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Classification boundary cases (§11.2.b). Pure JVM tests — [DeviceTags.classify]
 * takes raw RAM bytes + core count so no `ActivityManager` mock is needed.
 *
 * Boundaries that matter: exactly 3 GB RAM, exactly 4 cores (the floor of
 * `mid`); exactly 6 GB / 6 cores (the floor of `high`). A regression that
 * flips an inclusive boundary to exclusive would silently re-bucket a whole
 * device class.
 */
class DeviceTagsTest {
    private val gb = 1024L * 1024 * 1024

    @Test
    fun exactly3GbAnd4CoresIsMid() {
        assertEquals(DeviceTags.CLASS_MID, DeviceTags.classify(3 * gb, 4))
    }

    @Test
    fun justUnder3GbIsLow() {
        assertEquals(DeviceTags.CLASS_LOW, DeviceTags.classify(3 * gb - 1, 4))
    }

    @Test
    fun threeCoresIsLowEvenWithAmpleRam() {
        // Cores < 4 forces low regardless of RAM (slow axis dominates).
        assertEquals(DeviceTags.CLASS_LOW, DeviceTags.classify(8 * gb, 3))
    }

    @Test
    fun exactly6GbAnd6CoresIsHigh() {
        assertEquals(DeviceTags.CLASS_HIGH, DeviceTags.classify(6 * gb, 6))
    }

    @Test
    fun sixGbButOnlyFiveCoresIsMid() {
        // High on RAM, mid on cores → mid (lower axis wins).
        assertEquals(DeviceTags.CLASS_MID, DeviceTags.classify(6 * gb, 5))
    }

    @Test
    fun osMajorTakesLeadingComponent() {
        assertEquals("android.14", DeviceTags.osMajor("14"))
        assertEquals("android.13", DeviceTags.osMajor("13.0.1"))
        assertEquals("android.0", DeviceTags.osMajor(null))
        assertEquals("android.0", DeviceTags.osMajor(""))
    }
}
