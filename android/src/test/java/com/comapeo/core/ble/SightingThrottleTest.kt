package com.comapeo.core.ble

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SightingThrottleTest {
    private val payloadA = byteArrayOf(1, 2, 3)
    private val payloadB = byteArrayOf(1, 2, 4)

    @Test
    fun forwardsFirstSightingAndThrottlesRepeats() {
        val throttle = SightingThrottle(minIntervalMs = 1_000)
        assertTrue(throttle.shouldForward("AA", payloadA, nowMs = 0))
        assertFalse(throttle.shouldForward("AA", payloadA, nowMs = 500))
        assertTrue(throttle.shouldForward("AA", payloadA, nowMs = 1_000))
    }

    @Test
    fun forwardsChangedPayloadImmediately() {
        val throttle = SightingThrottle(minIntervalMs = 1_000)
        assertTrue(throttle.shouldForward("AA", payloadA, nowMs = 0))
        // Sync-state gossip: a changed payload bypasses the interval.
        assertTrue(throttle.shouldForward("AA", payloadB, nowMs = 100))
        assertFalse(throttle.shouldForward("AA", payloadB, nowMs = 200))
    }

    @Test
    fun throttlesPerSenderIndependently() {
        val throttle = SightingThrottle(minIntervalMs = 1_000)
        assertTrue(throttle.shouldForward("AA", payloadA, nowMs = 0))
        assertTrue(throttle.shouldForward("BB", payloadA, nowMs = 100))
        assertFalse(throttle.shouldForward("AA", payloadA, nowMs = 100))
    }

    @Test
    fun prunesIdleEntriesWhenFull() {
        val throttle = SightingThrottle(
            minIntervalMs = 1_000,
            maxEntries = 2,
            entryTtlMs = 10_000,
        )
        assertTrue(throttle.shouldForward("AA", payloadA, nowMs = 0))
        assertTrue(throttle.shouldForward("BB", payloadA, nowMs = 0))
        // AA and BB are idle past the TTL by now; a new sender prunes them.
        assertTrue(throttle.shouldForward("CC", payloadA, nowMs = 20_000))
        // AA's entry is gone, so its next sighting forwards fresh.
        assertTrue(throttle.shouldForward("AA", payloadA, nowMs = 20_100))
    }

    @Test
    fun clearForgetsEverything() {
        val throttle = SightingThrottle(minIntervalMs = 1_000)
        assertTrue(throttle.shouldForward("AA", payloadA, nowMs = 0))
        throttle.clear()
        assertTrue(throttle.shouldForward("AA", payloadA, nowMs = 1))
    }
}
