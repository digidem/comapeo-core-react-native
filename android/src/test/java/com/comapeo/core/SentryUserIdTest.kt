package com.comapeo.core

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Pinned vectors for the user.id derivation. The same vectors live in
 * `SentryUserIdTests.swift` — both platforms must derive identical IDs
 * from identical inputs so support can recompute a user's historical
 * monthly IDs from a shared root ID regardless of platform.
 *
 * Vectors are `sha256("<root>|<salt>")` hex, first 16 chars.
 */
class SentryUserIdTest {

    // 2026-07-01T00:00:00Z
    private val july2026Ms = 1_782_864_000_000L

    @Test
    fun monthlyVector() {
        assertEquals(
            "e15e7255ae360358",
            SentryUserId.derive("test-root", permanent = false, nowMs = july2026Ms),
        )
    }

    @Test
    fun permanentVector() {
        assertEquals(
            "cbd8388dc87b1a9c",
            SentryUserId.derive("test-root", permanent = true, nowMs = july2026Ms),
        )
    }

    @Test
    fun utcYearMonthPadsAndUsesUtc() {
        assertEquals("1970-01", SentryUserId.utcYearMonth(0L))
        // 1ms before the month boundary vs 1ms after — the rotation
        // boundary is UTC midnight, not device-local.
        val feb1970Ms = 31L * 24 * 60 * 60 * 1000
        assertEquals("1970-01", SentryUserId.utcYearMonth(feb1970Ms - 1))
        assertEquals("1970-02", SentryUserId.utcYearMonth(feb1970Ms))
        assertEquals("2026-07", SentryUserId.utcYearMonth(july2026Ms))
    }
}
