package com.comapeo.core.ble

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The pure error-code → blocker mapping the front end's UX hangs off. */
class BleDiscoveryEngineTest {
    @Test
    fun mapsKnownCodesToBlockers() {
        assertEquals("bluetooth-off", BleDiscoveryEngine.blockerFor("ERR_BLE_DISABLED"))
        assertEquals("no-adapter", BleDiscoveryEngine.blockerFor("ERR_BLE_UNAVAILABLE"))
        assertEquals("permission-missing", BleDiscoveryEngine.blockerFor("ERR_BLE_PERMISSION"))
    }

    @Test
    fun unknownCodesMapToNoBlocker() {
        assertNull(BleDiscoveryEngine.blockerFor("ERR_BLE_ADVERTISE_UNSUPPORTED"))
        assertNull(BleDiscoveryEngine.blockerFor("ERR_BLE_SCAN"))
    }
}
