package com.comapeo.core

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * JVM unit tests for [SentryFgsBridge]'s no-op guards. Ensures that:
 *
 *   1. Public methods short-circuit cleanly before init (so the
 *      FGS doesn't crash when `SentryConfig.loadFromManifest`
 *      returned null and `init` was never called).
 *   2. The `Class.forName` probe path is exercised — important
 *      because consumers without `@sentry/react-native` get a
 *      missing-classpath state at runtime that we can't replicate
 *      in unit tests without bytecode hacks. We at least verify
 *      the `initialized = false` short-circuit covers all
 *      surface methods without touching the SDK.
 *
 * The "SDK present, properly init'd" path is exercised by the
 * Phase 2b smoke test on a real device — it requires
 * `SentryAndroid.init` which constructs a real Hub, schedulers,
 * and breadcrumb queue; that's not something we want to spin up
 * in a JVM unit test.
 */
class SentryFgsBridgeTest {

    @After
    fun tearDown() {
        SentryFgsBridge.resetForTests()
    }

    @Test
    fun isEnabledFindsSentryAndroidOnTestClasspath() {
        // The android/build.gradle declares
        // `testImplementation "io.sentry:sentry-android-core:8.32.0"`,
        // so the JVM unit-test classpath has the SDK. Probe should
        // succeed.
        assertTrue(
            "Expected SentryAndroid on test classpath; check build.gradle testImplementation",
            SentryFgsBridge.isEnabled(),
        )
    }

    @Test
    fun addBreadcrumbBeforeInitIsNoOp() {
        // Pre-init: the bridge should drop the call without
        // touching Sentry at all. No throw, no crash, no event.
        SentryFgsBridge.addBreadcrumb(
            category = "comapeo.state",
            message = "STOPPED → STARTING",
            level = "info",
        )
        // Reaching this assert means the call returned cleanly.
        assertTrue("addBreadcrumb pre-init must not throw", true)
    }

    @Test
    fun captureExceptionBeforeInitIsNoOp() {
        SentryFgsBridge.captureException(
            RuntimeException("boom"),
            tags = mapOf("comapeo.phase" to "rootkey"),
        )
        assertTrue("captureException pre-init must not throw", true)
    }

    @Test
    fun captureMessageBeforeInitIsNoOp() {
        SentryFgsBridge.captureMessage(
            "comapeo: startup timeout fired",
            level = "error",
            tags = mapOf("timeout" to "startup"),
        )
        assertTrue("captureMessage pre-init must not throw", true)
    }

    @Test
    fun startBootTransactionBeforeInitReturnsNull() {
        // `null` is the documented "off" return so callers
        // (NodeJSService) can store with `bootTx.set(null)` and
        // their `bootTx.getAndSet(null)?.let { … }` close path
        // does the right thing — no-op until a real handle is
        // produced post-init.
        assertNull(SentryFgsBridge.startBootTransaction())
    }

    @Test
    fun startBootSpanBeforeInitReturnsNull() {
        assertNull(SentryFgsBridge.startBootSpan(null, "rootkey-load"))
        // Also null when we hand in a non-null fake — bridge
        // must not call into the SDK.
        assertNull(SentryFgsBridge.startBootSpan("fake-handle", "rootkey-load"))
    }

    @Test
    fun finishSpanWithNullHandleIsNoOp() {
        SentryFgsBridge.finishSpan(null, "ok")
        assertTrue("finishSpan(null) must not throw", true)
    }

    @Test
    fun finishSpanBeforeInitWithFakeHandleIsNoOp() {
        // Pre-init, the bridge must not interpret an arbitrary
        // handle — early return saves us from `ClassCastException`
        // on the Impl side.
        SentryFgsBridge.finishSpan("not-a-real-handle", "ok")
        assertTrue("finishSpan pre-init must not throw", true)
    }

    @Test
    fun resetForTestsClearsState() {
        // Smoke-test the test-only reset hook so subsequent tests
        // start from a clean slate.
        SentryFgsBridge.resetForTests()
        assertNull(SentryFgsBridge.startBootTransaction())
    }

    @Test
    fun isEnabledIsCached() {
        // Two calls should be idempotent; the second mustn't
        // re-probe (probing repeatedly would defeat the perf
        // mitigation). We can't directly observe whether the
        // probe ran, but two true returns are a sanity check.
        val first = SentryFgsBridge.isEnabled()
        val second = SentryFgsBridge.isEnabled()
        assertEquals(first, second)
        assertTrue(first)
    }
}
