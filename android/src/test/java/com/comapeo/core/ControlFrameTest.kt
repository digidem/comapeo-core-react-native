package com.comapeo.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * JVM-only unit tests for [ControlFrame.parse]. Deterministic — no
 * Android framework dependencies — so they run in the fast `test` task,
 * not `androidTest`.
 *
 * Coverage rationale: parser failures here are silent (every error
 * mode resolves to `Malformed`), so without these the only way a
 * regression in the parser would surface is via a lifecycle test that
 * happens to drive the right frame and notice the wrong outcome.
 */
class ControlFrameTest {

    @Test
    fun parsesStarted() {
        assertEquals(ControlFrame.Started, ControlFrame.parse("""{"type":"started"}"""))
    }

    @Test
    fun parsesReady() {
        assertEquals(ControlFrame.Ready, ControlFrame.parse("""{"type":"ready"}"""))
    }

    @Test
    fun parsesStopping() {
        assertEquals(ControlFrame.Stopping, ControlFrame.parse("""{"type":"stopping"}"""))
    }

    @Test
    fun parsesErrorWithPhaseAndMessage() {
        val frame = ControlFrame.parse(
            """{"type":"error","phase":"construct","message":"boom"}"""
        )
        assertEquals(
            ControlFrame.Error(phase = "construct", message = "boom"),
            frame,
        )
    }

    @Test
    fun parsesErrorWithDefaults() {
        // Missing phase + message — protocol-permissive; defaults so
        // downstream consumers never see null.
        val frame = ControlFrame.parse("""{"type":"error"}""")
        assertEquals(
            ControlFrame.Error(phase = "unknown", message = "(no message)"),
            frame,
        )
    }

    @Test
    fun parsesErrorIgnoringExtraFields() {
        // Forward-compat: future fields (e.g. `stack`) shouldn't break
        // the parse.
        val frame = ControlFrame.parse(
            """{"type":"error","phase":"init","message":"x","stack":"trace"}"""
        )
        assertEquals(
            ControlFrame.Error(phase = "init", message = "x"),
            frame,
        )
    }

    @Test
    fun nonJsonReturnsMalformed() {
        val frame = ControlFrame.parse("not json at all")
        assertTrue("expected Malformed, got $frame", frame is ControlFrame.Malformed)
        val detail = (frame as ControlFrame.Malformed).detail
        assertTrue(
            "Malformed detail should describe non-JSON input: $detail",
            detail.contains("Non-JSON"),
        )
    }

    @Test
    fun emptyStringReturnsMalformed() {
        val frame = ControlFrame.parse("")
        assertTrue("expected Malformed, got $frame", frame is ControlFrame.Malformed)
    }

    @Test
    fun missingTypeReturnsMalformed() {
        val frame = ControlFrame.parse("""{"foo":"bar"}""")
        assertTrue(frame is ControlFrame.Malformed)
        // Empty-string type produces an "Unknown control frame type=\"\""
        // detail; still a Malformed, the message names the empty type.
        val detail = (frame as ControlFrame.Malformed).detail
        assertTrue(
            "Malformed detail should mention type: $detail",
            detail.contains("type="),
        )
    }

    @Test
    fun unknownTypeReturnsMalformed() {
        val frame = ControlFrame.parse("""{"type":"forwardCompat"}""")
        assertTrue(frame is ControlFrame.Malformed)
        val detail = (frame as ControlFrame.Malformed).detail
        assertTrue(
            "Malformed detail should include the unknown type name: $detail",
            detail.contains("forwardCompat"),
        )
    }

    @Test
    fun nonJsonDetailIsTruncated() {
        // 200-char input — detail should not paste the whole thing.
        val long = "x".repeat(200)
        val frame = ControlFrame.parse(long)
        val detail = (frame as ControlFrame.Malformed).detail
        // The implementation takes the first 100 chars of the raw
        // input. The detail header ("Non-JSON control frame: ") plus
        // those 100 chars stays well under the original 200.
        assertTrue(
            "detail should be shorter than the raw 200-char input",
            detail.length < long.length,
        )
    }
}
