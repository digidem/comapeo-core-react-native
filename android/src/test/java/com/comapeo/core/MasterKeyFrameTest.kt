package com.comapeo.core

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.util.Base64

/**
 * JVM-only tests for the inbound `master-key` gate. `android.util.Base64` is
 * unavailable here, so the JDK decoder is injected — both are standard base64,
 * so the accept/reject decisions are the same.
 */
class MasterKeyFrameTest {

    private fun decode(base64: String): ByteArray? =
        MasterKeyFrame.decode(base64) { Base64.getDecoder().decode(it) }

    @Test
    fun decodesAValidKey() {
        val expected = ByteArray(32) { it.toByte() }

        assertArrayEquals(expected, decode(Base64.getEncoder().encodeToString(expected)))
    }

    @Test
    fun rejectsNonBase64Characters() {
        val valid = Base64.getEncoder().encodeToString(ByteArray(32))

        assertNull(decode("*" + valid.drop(1)))
        assertNull(decode(valid.replace('=', 'A')))
    }

    @Test
    fun rejectsWrongLengthKeys() {
        assertNull(decode(Base64.getEncoder().encodeToString(ByteArray(31))))
        assertNull(decode(Base64.getEncoder().encodeToString(ByteArray(33))))
    }

    @Test
    fun rejectsAnEmptyString() {
        assertNull(decode(""))
    }

    @Test
    fun acceptsSetTrailingBits() {
        // The last base64 character carries 2 bits the 32 bytes don't use, so
        // several strings decode to the same key. Unlike the init frame's
        // inbound check, they are accepted here: the sender is our own backend.
        val key = ByteArray(32)
        val encoded = Base64.getEncoder().encodeToString(key)
        val nonStandard = encoded.dropLast(2) + "B="

        assertArrayEquals(key, decode(nonStandard))
    }

    @Test
    fun returnsNullWhenTheDecoderThrows() {
        assertNull(
            MasterKeyFrame.decode(Base64.getEncoder().encodeToString(ByteArray(32))) {
                throw IllegalArgumentException("bad input")
            },
        )
    }
}
