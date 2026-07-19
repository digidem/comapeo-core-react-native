package com.comapeo.core.ble

import org.junit.Assert.assertArrayEquals
import org.junit.Test

/**
 * The SDK → runtime-permission mapping. `Manifest.permission.*` and
 * `Build.VERSION_CODES.S` are compile-time constants, so this runs on
 * the plain JVM without an Android runtime.
 */
class BlePermissionsTest {
    @Test
    fun api31PlusUsesTheNearbyDevicesGroup() {
        val expected = arrayOf(
            "android.permission.BLUETOOTH_SCAN",
            "android.permission.BLUETOOTH_ADVERTISE",
            "android.permission.BLUETOOTH_CONNECT",
        )
        assertArrayEquals(expected, BlePermissions.required(31))
        assertArrayEquals(expected, BlePermissions.required(35))
    }

    @Test
    fun legacyApisUseFineLocation() {
        val expected = arrayOf("android.permission.ACCESS_FINE_LOCATION")
        assertArrayEquals(expected, BlePermissions.required(24))
        assertArrayEquals(expected, BlePermissions.required(30))
    }
}
