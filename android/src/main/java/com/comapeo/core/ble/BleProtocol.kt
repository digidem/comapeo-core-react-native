package com.comapeo.core.ble

/**
 * Wire-format constants shared by the advertiser and the scanner. The
 * source of truth for the payload layout is the TS codec
 * (`src/ble/wire-format.ts`) and docs/ble-discovery.md — native code
 * treats the payload as opaque bytes and only owns the company ID and
 * the "CM" scan-filter prefix.
 */
object BleProtocol {
    /**
     * Bluetooth SIG company identifier. 0xFFFF is the reserved/testing
     * value (design decision D8): CoMapeo has no registered SIG ID yet,
     * and the "CM" magic prefix disambiguates us from other 0xFFFF
     * users. Registering later is a one-constant change here + in
     * `src/ble/wire-format.ts`.
     */
    const val COMPANY_ID = 0xFFFF

    /** "CM" — first two payload bytes; what the hardware scan filter matches. */
    val MAGIC = byteArrayOf(0x43, 0x4D)

    /** Match both magic bytes exactly. */
    val MAGIC_MASK = byteArrayOf(0xFF.toByte(), 0xFF.toByte())

    /**
     * Ceiling for the manufacturer-data payload in a legacy (31-byte)
     * advertisement: 31 − 3 (flags AD) − 2 (AD header) − 2 (company ID).
     * The v1 payload is 21 bytes; this guards against a JS-side format
     * change silently producing an advertisement the radio rejects.
     */
    const val MAX_PAYLOAD_LENGTH = 24
}
