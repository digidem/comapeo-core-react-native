package com.comapeo.core

import android.util.Base64

/**
 * Validation of the inbound `master-key` frame, kept free of the service so
 * the gate is unit-testable on the JVM.
 */
internal object MasterKeyFrame {

    const val MASTER_KEY_BYTE_LENGTH = 32

    /** Same shape `backend/lib/parse-init.js` accepts for the outbound field. */
    private val STRICT_BASE64 = Regex("^[A-Za-z0-9\\+/]{43}=$")

    /**
     * Returns the 32 raw bytes of [base64], or null when it is not the strict
     * base64 of a 32-byte key. The caller owns zeroing the result.
     *
     * No trailing-bits round-trip check (unlike `parse-init.js` inbound): the
     * sender is our own backend, whose `Buffer.toString("base64")` always
     * emits the standard encoding.
     *
     * @param decoder test seam — `android.util.Base64` is not available on the JVM.
     */
    fun decode(
        base64: String,
        decoder: (String) -> ByteArray = { Base64.decode(it, Base64.NO_WRAP) },
    ): ByteArray? {
        if (!STRICT_BASE64.matches(base64)) return null
        val bytes = try {
            decoder(base64)
        } catch (_: Throwable) {
            return null
        }
        if (bytes.size != MASTER_KEY_BYTE_LENGTH) {
            bytes.fill(0)
            return null
        }
        return bytes
    }
}
