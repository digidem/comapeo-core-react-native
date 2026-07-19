package com.comapeo.core.ble

/**
 * Per-sender rate limit for forwarding scan results to the backend.
 *
 * A device in range produces a scan callback every few hundred ms;
 * across a 20–30 device group that's hundreds of frames/second of
 * identical data over the control socket. Forwarding policy:
 *
 * - a **changed payload** for a sender is forwarded immediately (that's
 *   the sync-state gossip — a peer's state hash just moved);
 * - an unchanged payload is forwarded at most once per [minIntervalMs]
 *   (keeps the backend's presence/RSSI view fresh without the spam).
 *
 * Keyed by BLE MAC. Randomized-MAC churn is bounded by [prune]:
 * entries idle for [entryTtlMs] are dropped whenever the map exceeds
 * [maxEntries]. Not thread-safe — call from the scanner callback
 * thread only.
 */
class SightingThrottle(
    private val minIntervalMs: Long = DEFAULT_MIN_INTERVAL_MS,
    private val maxEntries: Int = DEFAULT_MAX_ENTRIES,
    private val entryTtlMs: Long = DEFAULT_ENTRY_TTL_MS,
) {
    private data class Entry(var atMs: Long, var payloadHash: Int)

    private val entries = HashMap<String, Entry>()

    fun shouldForward(address: String, payload: ByteArray, nowMs: Long): Boolean {
        val hash = payload.contentHashCode()
        val prev = entries[address]
        if (prev != null && prev.payloadHash == hash && nowMs - prev.atMs < minIntervalMs) {
            return false
        }
        if (prev == null && entries.size >= maxEntries) prune(nowMs)
        val entry = prev ?: Entry(nowMs, hash).also { entries[address] = it }
        entry.atMs = nowMs
        entry.payloadHash = hash
        return true
    }

    fun clear() = entries.clear()

    private fun prune(nowMs: Long) {
        entries.entries.removeAll { (_, entry) -> nowMs - entry.atMs > entryTtlMs }
    }

    companion object {
        const val DEFAULT_MIN_INTERVAL_MS = 1_000L
        const val DEFAULT_MAX_ENTRIES = 256
        const val DEFAULT_ENTRY_TTL_MS = 5 * 60_000L
    }
}
