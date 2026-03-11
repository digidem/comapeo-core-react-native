package com.comapeo.core

import org.junit.Assert.assertEquals
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * JVM unit tests for the length-prefixed message framing protocol.
 *
 * The IPC protocol uses 4-byte little-endian length prefix followed by
 * UTF-8 JSON payload. These tests verify encoding/decoding correctness
 * without needing an Android device.
 */
class MessageFramingTest {

    /**
     * Encode a message the same way [NodeJSIPC.sendMessageInternal] does.
     */
    private fun encodeFrame(message: String): ByteArray {
        val messageBytes = message.toByteArray(Charsets.UTF_8)
        val lengthBytes = ByteBuffer.allocate(4)
            .order(ByteOrder.LITTLE_ENDIAN)
            .putInt(messageBytes.size)
            .array()
        return lengthBytes + messageBytes
    }

    /**
     * Decode a frame the same way [NodeJSIPC.receiveMessage] does.
     */
    private fun decodeFrame(frame: ByteArray): String {
        val length = ByteBuffer.wrap(frame, 0, 4)
            .order(ByteOrder.LITTLE_ENDIAN)
            .int
        return String(frame, 4, length, Charsets.UTF_8)
    }

    @Test
    fun encodesEmptyMessage() {
        val frame = encodeFrame("")
        assertEquals(4, frame.size) // just the length prefix
        assertEquals(0, ByteBuffer.wrap(frame, 0, 4).order(ByteOrder.LITTLE_ENDIAN).int)
    }

    @Test
    fun encodesSimpleJson() {
        val message = """{"type":"test"}"""
        val frame = encodeFrame(message)

        // Length prefix should be the byte length of the message
        val expectedLength = message.toByteArray(Charsets.UTF_8).size
        val actualLength = ByteBuffer.wrap(frame, 0, 4).order(ByteOrder.LITTLE_ENDIAN).int
        assertEquals(expectedLength, actualLength)

        // Total frame size = 4 (prefix) + message bytes
        assertEquals(4 + expectedLength, frame.size)
    }

    @Test
    fun roundTripSimpleMessage() {
        val original = """{"key":"value","num":42}"""
        val frame = encodeFrame(original)
        val decoded = decodeFrame(frame)
        assertEquals(original, decoded)
    }

    @Test
    fun roundTripUnicodeMessage() {
        // UTF-8 multi-byte characters: byte length != char length
        val original = """{"name":"日本語テスト","emoji":"🗺️"}"""
        val frame = encodeFrame(original)
        val decoded = decodeFrame(frame)
        assertEquals(original, decoded)

        // Verify length prefix is byte length, not char length
        val byteLength = original.toByteArray(Charsets.UTF_8).size
        val encodedLength = ByteBuffer.wrap(frame, 0, 4).order(ByteOrder.LITTLE_ENDIAN).int
        assertEquals(byteLength, encodedLength)
    }

    @Test
    fun roundTripLargeMessage() {
        // Message larger than the 1KB reuse buffer in NodeJSIPC
        val payload = "x".repeat(2048)
        val original = """{"data":"$payload"}"""
        val frame = encodeFrame(original)
        val decoded = decodeFrame(frame)
        assertEquals(original, decoded)
    }

    @Test
    fun roundTripNestedJson() {
        val original = """{"outer":{"inner":{"deep":[1,2,3]}},"array":["a","b"]}"""
        val frame = encodeFrame(original)
        val decoded = decodeFrame(frame)
        assertEquals(original, decoded)
    }

    @Test
    fun lengthPrefixIsLittleEndian() {
        val message = "x".repeat(256) // 0x100 bytes
        val frame = encodeFrame(message)

        // Little-endian: LSB first
        // 256 = 0x00000100 → bytes: [0x00, 0x01, 0x00, 0x00]
        assertEquals(0x00.toByte(), frame[0])
        assertEquals(0x01.toByte(), frame[1])
        assertEquals(0x00.toByte(), frame[2])
        assertEquals(0x00.toByte(), frame[3])
    }

    @Test
    fun multipleFramesInSequence() {
        val messages = listOf(
            """{"id":1}""",
            """{"id":2,"data":"hello"}""",
            """{"id":3}"""
        )

        // Encode all frames into a single byte stream
        val stream = messages.map { encodeFrame(it) }.reduce { acc, bytes -> acc + bytes }

        // Decode frames sequentially
        var offset = 0
        val decoded = mutableListOf<String>()
        while (offset < stream.size) {
            val length = ByteBuffer.wrap(stream, offset, 4)
                .order(ByteOrder.LITTLE_ENDIAN)
                .int
            offset += 4
            decoded.add(String(stream, offset, length, Charsets.UTF_8))
            offset += length
        }

        assertEquals(messages, decoded)
    }

    @Test
    fun sendLengthBufferReuseIsCorrect() {
        // Simulates the buffer reuse pattern in NodeJSIPC.sendMessageInternal
        val sendLengthBuffer = ByteArray(4)

        val messages = listOf("short", "a".repeat(1000), "tiny")
        for (message in messages) {
            val messageBytes = message.toByteArray(Charsets.UTF_8)
            ByteBuffer.wrap(sendLengthBuffer)
                .order(ByteOrder.LITTLE_ENDIAN)
                .putInt(messageBytes.size)

            val decodedLength = ByteBuffer.wrap(sendLengthBuffer)
                .order(ByteOrder.LITTLE_ENDIAN)
                .int
            assertEquals(
                "Buffer reuse should produce correct length for '${message.take(20)}...'",
                messageBytes.size,
                decodedLength
            )
        }
    }

    @Test
    fun receiveLengthBufferDecodesCorrectly() {
        // Test the exact decoding logic used in NodeJSIPC.receiveMessage
        val receiveLengthBuffer = ByteArray(4)
        val testLength = 42

        // Write length in little-endian
        ByteBuffer.wrap(receiveLengthBuffer)
            .order(ByteOrder.LITTLE_ENDIAN)
            .putInt(testLength)

        // Read it back (same as receiveMessage does)
        val decoded = ByteBuffer.wrap(receiveLengthBuffer)
            .order(ByteOrder.LITTLE_ENDIAN)
            .int
        assertEquals(testLength, decoded)
    }

    @Test
    fun receiveBufferReuseForSmallMessages() {
        // Simulates the buffer reuse pattern in NodeJSIPC.receiveMessage
        val receiveMessageBuffer = ByteArray(1024)

        // First message: fills part of the buffer
        val msg1 = "hello"
        val msg1Bytes = msg1.toByteArray(Charsets.UTF_8)
        System.arraycopy(msg1Bytes, 0, receiveMessageBuffer, 0, msg1Bytes.size)
        val decoded1 = receiveMessageBuffer.decodeToString(0, msg1Bytes.size)
        assertEquals(msg1, decoded1)

        // Second shorter message: reuses same buffer, stale data beyond length is ignored
        val msg2 = "hi"
        val msg2Bytes = msg2.toByteArray(Charsets.UTF_8)
        System.arraycopy(msg2Bytes, 0, receiveMessageBuffer, 0, msg2Bytes.size)
        val decoded2 = receiveMessageBuffer.decodeToString(0, msg2Bytes.size)
        assertEquals(msg2, decoded2)

        // Verify stale data from msg1 doesn't leak (bytes after msg2 length are still there
        // but decodeToString with correct length ignores them)
        assertEquals('l', receiveMessageBuffer[2].toInt().toChar()) // stale from "hello"
    }
}
