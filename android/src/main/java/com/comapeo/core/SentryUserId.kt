package com.comapeo.core

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Calendar
import java.util.TimeZone

/**
 * Derives the Sentry `user.id` from the permanent per-install root user ID
 * (see [ComapeoPrefs.readRootUserId]). The root ID itself never leaves the
 * device; Sentry only ever sees a truncated hash:
 *
 * - usage opt-in **off** → `sha256("<root>|<YYYY-MM UTC>")` — rotates each
 *   UTC month so cross-month events can't be linked to one install;
 * - usage opt-in **on** → `sha256("<root>|permanent")` — stable across
 *   launches and months so cohort analysis works.
 *
 * Both are recoverable from a user-shared root ID, so historical events can
 * be re-associated for a support case. Must stay in lock-step with
 * `SentryUserId.swift` (shared test vectors in both suites).
 */
internal object SentryUserId {
    const val PERMANENT_SALT = "permanent"
    private const val ID_LENGTH = 16

    /**
     * Crockford-style base32: no I/L/O/U, so a root ID read off a screen and
     * typed back by hand can't be mis-transcribed. Must match `SentryUserId.swift`.
     */
    const val ROOT_ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

    /**
     * A fresh root user ID: 12 alphabet chars grouped `XXXX-XXXX-XXXX` (60
     * bits — comfortable headroom against collisions across the install base
     * while staying short enough to copy from a screen by hand). Stored and
     * hashed exactly as formatted, hyphens included.
     */
    fun generateRootId(random: SecureRandom = SecureRandom()): String =
        CharArray(12) { ROOT_ID_ALPHABET[random.nextInt(ROOT_ID_ALPHABET.length)] }
            .concatToString()
            .chunked(4)
            .joinToString("-")

    fun derive(rootUserId: String, permanent: Boolean, nowMs: Long): String {
        val salt = if (permanent) PERMANENT_SALT else utcYearMonth(nowMs)
        return sha256Hex("$rootUserId|$salt").substring(0, ID_LENGTH)
    }

    /** `YYYY-MM` in UTC. */
    fun utcYearMonth(nowMs: Long): String {
        val cal = Calendar.getInstance(TimeZone.getTimeZone("UTC"))
        cal.timeInMillis = nowMs
        val year = cal.get(Calendar.YEAR)
        val month = cal.get(Calendar.MONTH) + 1
        return "%04d-%02d".format(year, month)
    }

    private fun sha256Hex(input: String): String =
        MessageDigest.getInstance("SHA-256")
            .digest(input.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
}
