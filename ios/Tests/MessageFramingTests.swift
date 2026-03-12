import XCTest

/// Unit tests for the length-prefixed message framing protocol.
///
/// The IPC protocol uses 4-byte little-endian length prefix followed by
/// UTF-8 JSON payload. These tests verify encoding/decoding correctness
/// without needing an iOS device — mirroring Android's `MessageFramingTest.kt`.
final class MessageFramingTests: XCTestCase {

    /// Encode a message the same way `NodeJSIPC.sendMessageInternal` does.
    private func encodeFrame(_ message: String) -> Data {
        let messageBytes = message.data(using: .utf8)!
        var length = UInt32(messageBytes.count).littleEndian
        var frame = Data(bytes: &length, count: 4)
        frame.append(messageBytes)
        return frame
    }

    /// Decode a frame the same way `NodeJSIPC.receiveMessage` does.
    private func decodeFrame(_ frame: Data) -> String {
        let length = Int(
            UInt32(frame[0]) |
            UInt32(frame[1]) << 8 |
            UInt32(frame[2]) << 16 |
            UInt32(frame[3]) << 24
        )
        return String(data: frame.subdata(in: 4..<(4 + length)), encoding: .utf8)!
    }

    func testEncodesEmptyMessage() {
        let frame = encodeFrame("")
        XCTAssertEqual(frame.count, 4) // just the length prefix
        let length = frame.withUnsafeBytes { $0.load(as: UInt32.self).littleEndian }
        XCTAssertEqual(length, 0)
    }

    func testEncodesSimpleJson() {
        let message = #"{"type":"test"}"#
        let frame = encodeFrame(message)

        let expectedLength = message.data(using: .utf8)!.count
        let actualLength = Int(
            UInt32(frame[0]) |
            UInt32(frame[1]) << 8 |
            UInt32(frame[2]) << 16 |
            UInt32(frame[3]) << 24
        )
        XCTAssertEqual(expectedLength, actualLength)
        XCTAssertEqual(frame.count, 4 + expectedLength)
    }

    func testRoundTripSimpleMessage() {
        let original = #"{"key":"value","num":42}"#
        let frame = encodeFrame(original)
        let decoded = decodeFrame(frame)
        XCTAssertEqual(original, decoded)
    }

    func testRoundTripUnicodeMessage() {
        let original = #"{"name":"日本語テスト","emoji":"🗺️"}"#
        let frame = encodeFrame(original)
        let decoded = decodeFrame(frame)
        XCTAssertEqual(original, decoded)

        // Verify length prefix is byte length, not char length
        let byteLength = original.data(using: .utf8)!.count
        let encodedLength = Int(
            UInt32(frame[0]) |
            UInt32(frame[1]) << 8 |
            UInt32(frame[2]) << 16 |
            UInt32(frame[3]) << 24
        )
        XCTAssertEqual(byteLength, encodedLength)
    }

    func testRoundTripLargeMessage() {
        let payload = String(repeating: "x", count: 2048)
        let original = #"{"data":"\#(payload)"}"#
        let frame = encodeFrame(original)
        let decoded = decodeFrame(frame)
        XCTAssertEqual(original, decoded)
    }

    func testRoundTripNestedJson() {
        let original = #"{"outer":{"inner":{"deep":[1,2,3]}},"array":["a","b"]}"#
        let frame = encodeFrame(original)
        let decoded = decodeFrame(frame)
        XCTAssertEqual(original, decoded)
    }

    func testLengthPrefixIsLittleEndian() {
        let message = String(repeating: "x", count: 256) // 0x100 bytes
        let frame = encodeFrame(message)

        // Little-endian: LSB first
        // 256 = 0x00000100 -> bytes: [0x00, 0x01, 0x00, 0x00]
        XCTAssertEqual(frame[0], 0x00)
        XCTAssertEqual(frame[1], 0x01)
        XCTAssertEqual(frame[2], 0x00)
        XCTAssertEqual(frame[3], 0x00)
    }

    func testMultipleFramesInSequence() {
        let messages = [
            #"{"id":1}"#,
            #"{"id":2,"data":"hello"}"#,
            #"{"id":3}"#
        ]

        // Encode all frames into a single byte stream
        var stream = Data()
        for msg in messages {
            stream.append(encodeFrame(msg))
        }

        // Decode frames sequentially
        var offset = 0
        var decoded = [String]()
        while offset < stream.count {
            let length = Int(
                UInt32(stream[offset]) |
                UInt32(stream[offset + 1]) << 8 |
                UInt32(stream[offset + 2]) << 16 |
                UInt32(stream[offset + 3]) << 24
            )
            offset += 4
            let msg = String(data: stream.subdata(in: offset..<(offset + length)), encoding: .utf8)!
            decoded.append(msg)
            offset += length
        }

        XCTAssertEqual(messages, decoded)
    }

    func testSendLengthBufferReuseIsCorrect() {
        // Simulates the buffer reuse pattern in NodeJSIPC.sendMessageInternal
        var sendLengthBuffer = Data(count: 4)

        let messages = ["short", String(repeating: "a", count: 1000), "tiny"]
        for message in messages {
            let messageBytes = message.data(using: .utf8)!
            var length = UInt32(messageBytes.count).littleEndian
            sendLengthBuffer = Data(bytes: &length, count: 4)

            let decodedLength = Int(
                UInt32(sendLengthBuffer[0]) |
                UInt32(sendLengthBuffer[1]) << 8 |
                UInt32(sendLengthBuffer[2]) << 16 |
                UInt32(sendLengthBuffer[3]) << 24
            )
            XCTAssertEqual(
                messageBytes.count,
                decodedLength,
                "Buffer reuse should produce correct length for '\(message.prefix(20))...'"
            )
        }
    }

    func testReceiveLengthBufferDecodesCorrectly() {
        let testLength: UInt32 = 42

        var lengthBuffer = Data(count: 4)
        var leLength = testLength.littleEndian
        lengthBuffer = Data(bytes: &leLength, count: 4)

        let decoded = Int(
            UInt32(lengthBuffer[0]) |
            UInt32(lengthBuffer[1]) << 8 |
            UInt32(lengthBuffer[2]) << 16 |
            UInt32(lengthBuffer[3]) << 24
        )
        XCTAssertEqual(Int(testLength), decoded)
    }

    func testReceiveBufferReuseForSmallMessages() {
        var receiveMessageBuffer = Data(count: 1024)

        // First message: fills part of the buffer
        let msg1 = "hello"
        let msg1Bytes = msg1.data(using: .utf8)!
        receiveMessageBuffer.replaceSubrange(0..<msg1Bytes.count, with: msg1Bytes)
        let decoded1 = String(data: receiveMessageBuffer.subdata(in: 0..<msg1Bytes.count), encoding: .utf8)!
        XCTAssertEqual(msg1, decoded1)

        // Second shorter message: reuses same buffer, stale data beyond length is ignored
        let msg2 = "hi"
        let msg2Bytes = msg2.data(using: .utf8)!
        receiveMessageBuffer.replaceSubrange(0..<msg2Bytes.count, with: msg2Bytes)
        let decoded2 = String(data: receiveMessageBuffer.subdata(in: 0..<msg2Bytes.count), encoding: .utf8)!
        XCTAssertEqual(msg2, decoded2)

        // Verify stale data from msg1 doesn't leak
        XCTAssertEqual(receiveMessageBuffer[2], Character("l").asciiValue!)
    }
}
