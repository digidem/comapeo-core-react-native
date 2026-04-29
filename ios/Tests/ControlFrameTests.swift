import XCTest
@testable internal import ComapeoCore

/// Pure unit tests for `ControlFrame.parse`. No simulator / device
/// dependencies — runs as part of the swift-test target.
///
/// Coverage rationale: parser failures here are silent (every error
/// mode resolves to `.malformed`), so without these the only way a
/// regression in the parser would surface is via a lifecycle test that
/// happens to drive the right frame and notice the wrong outcome.
final class ControlFrameTests: XCTestCase {

    func testParsesStarted() {
        let frame = ControlFrame.parse(#"{"type":"started"}"#)
        guard case .started = frame else {
            XCTFail("expected .started, got \(frame)"); return
        }
    }

    func testParsesReady() {
        let frame = ControlFrame.parse(#"{"type":"ready"}"#)
        guard case .ready = frame else {
            XCTFail("expected .ready, got \(frame)"); return
        }
    }

    func testParsesErrorWithPhaseAndMessage() {
        let frame = ControlFrame.parse(
            #"{"type":"error","phase":"construct","message":"boom"}"#
        )
        guard case let .error(phase, message) = frame else {
            XCTFail("expected .error, got \(frame)"); return
        }
        XCTAssertEqual(phase, "construct")
        XCTAssertEqual(message, "boom")
    }

    func testParsesErrorWithDefaults() {
        // Missing phase + message — protocol-permissive; defaults so
        // downstream consumers never see nil.
        let frame = ControlFrame.parse(#"{"type":"error"}"#)
        guard case let .error(phase, message) = frame else {
            XCTFail("expected .error, got \(frame)"); return
        }
        XCTAssertEqual(phase, "unknown")
        XCTAssertEqual(message, "(no message)")
    }

    func testParsesErrorIgnoringExtraFields() {
        // Forward-compat: future fields (e.g. `stack`) shouldn't break
        // the parse.
        let frame = ControlFrame.parse(
            #"{"type":"error","phase":"init","message":"x","stack":"trace"}"#
        )
        guard case let .error(phase, message) = frame else {
            XCTFail("expected .error, got \(frame)"); return
        }
        XCTAssertEqual(phase, "init")
        XCTAssertEqual(message, "x")
    }

    func testNonJSONReturnsMalformed() {
        let frame = ControlFrame.parse("not json at all")
        guard case let .malformed(detail) = frame else {
            XCTFail("expected .malformed, got \(frame)"); return
        }
        XCTAssertTrue(
            detail.contains("Non-JSON"),
            "Malformed detail should describe non-JSON input: \(detail)"
        )
    }

    func testEmptyStringReturnsMalformed() {
        let frame = ControlFrame.parse("")
        guard case .malformed = frame else {
            XCTFail("expected .malformed, got \(frame)"); return
        }
    }

    func testMissingTypeReturnsMalformed() {
        let frame = ControlFrame.parse(#"{"foo":"bar"}"#)
        guard case let .malformed(detail) = frame else {
            XCTFail("expected .malformed, got \(frame)"); return
        }
        // Empty-string type produces an `Unknown control frame type=""`
        // detail; still a .malformed, the message names the empty type.
        XCTAssertTrue(
            detail.contains("type="),
            "Malformed detail should mention type: \(detail)"
        )
    }

    func testUnknownTypeReturnsMalformed() {
        let frame = ControlFrame.parse(#"{"type":"forwardCompat"}"#)
        guard case let .malformed(detail) = frame else {
            XCTFail("expected .malformed, got \(frame)"); return
        }
        XCTAssertTrue(
            detail.contains("forwardCompat"),
            "Malformed detail should include the unknown type name: \(detail)"
        )
    }

    func testNonJSONDetailIsTruncated() {
        // 200-char input — detail should not paste the whole thing.
        let long = String(repeating: "x", count: 200)
        let frame = ControlFrame.parse(long)
        guard case let .malformed(detail) = frame else {
            XCTFail("expected .malformed, got \(frame)"); return
        }
        XCTAssertLessThan(
            detail.count,
            long.count,
            "detail should be shorter than the raw 200-char input"
        )
    }
}
