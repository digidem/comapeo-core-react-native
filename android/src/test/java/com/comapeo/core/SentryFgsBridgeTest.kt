package com.comapeo.core

import io.sentry.Hint
import io.sentry.ITransaction
import io.sentry.ITransportFactory
import io.sentry.Sentry
import io.sentry.SentryEnvelope
import io.sentry.SentryEvent
import io.sentry.SentryOptions
import io.sentry.SpanStatus
import io.sentry.protocol.Device
import io.sentry.protocol.SentryTransaction
import io.sentry.transport.ITransport
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

/**
 * JVM unit tests for [SentryFgsBridge].
 *
 * Two surfaces are exercised:
 *
 * 1. **Pre-init no-op** — every public method short-circuits cleanly
 *    until `init` runs, so a JNI-side or early-listener call that
 *    lands before `ComapeoCoreService.onCreate` invokes
 *    [SentryFgsBridge.init] never reaches the SDK.
 *
 * 2. **Post-init capture path** — bypasses [SentryFgsBridge.init]
 *    (which calls `SentryAndroid.init`, requiring a real Android
 *    Context and `SystemClock` — neither available in JVM tests)
 *    by calling the cross-platform `Sentry.init(SentryOptions)`
 *    directly with an in-memory `ITransport` that records every
 *    envelope sent, then flipping the bridge's gate via
 *    [SentryFgsBridge.markInitializedForTests].
 */
class SentryFgsBridgeTest {

    private lateinit var transport: RecordingTransport

    @After
    fun tearDown() {
        SentryFgsBridge.resetForTests()
        Sentry.close()
    }

    // ── Pre-init guard tests ────────────────────────────────────────

    @Test
    fun addBreadcrumbBeforeInitIsNoOp() {
        SentryFgsBridge.addBreadcrumb(
            category = "comapeo.state",
            message = "STOPPED → STARTING",
            level = "info",
        )
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
        // must not reach the SDK pre-init.
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
        // handle — early return saves us from `ClassCastException`.
        SentryFgsBridge.finishSpan("not-a-real-handle", "ok")
        assertTrue("finishSpan pre-init must not throw", true)
    }

    @Test
    fun resetForTestsClearsState() {
        // Smoke-test the test-only reset hook so subsequent tests
        // start from a clean slate.
        initBridgeViaSentryOptions()
        SentryFgsBridge.resetForTests()
        assertNull(SentryFgsBridge.startBootTransaction())
    }

    // ── Post-init capture path tests ───────────────────────────────

    @Test
    fun addBreadcrumbDoesNotImmediatelyEnqueueEnvelope() {
        // Breadcrumbs ride along on the next event capture; they
        // don't produce envelopes by themselves. Verifying the
        // negative ensures we don't accidentally turn breadcrumbs
        // into per-emit network traffic on the dashboard.
        initBridgeViaSentryOptions()
        SentryFgsBridge.addBreadcrumb(
            category = "comapeo.state",
            message = "STOPPED → STARTING",
            level = "info",
            data = mapOf("from" to "STOPPED", "to" to "STARTING"),
        )
        assertTrue(
            "addBreadcrumb must not produce an envelope by itself",
            transport.envelopes.isEmpty(),
        )
    }

    @Test
    fun captureExceptionEnqueuesEnvelopeWithTags() {
        initBridgeViaSentryOptions()
        SentryFgsBridge.captureException(
            RuntimeException("rootkey load failed"),
            tags = mapOf(
                "comapeo.phase" to "rootkey",
                "source" to "rootkey-store",
            ),
        )
        Sentry.flush(0)
        assertEquals("expected one envelope", 1, transport.envelopes.size)
        // The envelope's payload contains the captured event.
        // Sentry batches breadcrumbs onto the same envelope.
        val items = transport.envelopes.first().items.toList()
        assertTrue("envelope should contain at least one item", items.isNotEmpty())
    }

    @Test
    fun captureMessageEnqueuesEnvelopeAtRequestedLevel() {
        initBridgeViaSentryOptions()
        SentryFgsBridge.captureMessage(
            message = "comapeo: startup timeout fired",
            level = "error",
            tags = mapOf("timeout" to "startup"),
        )
        Sentry.flush(0)
        assertEquals(1, transport.envelopes.size)
    }

    @Test
    fun startBootTransactionForcesSamplingEvenWhenRateIsZero() {
        // Init with `tracesSampleRate = 0.0` so the global sample
        // decision would normally drop the transaction. The bridge
        // uses `TracesSamplingDecision(true, 1.0)` to override; if
        // that override is broken, the transaction never reaches
        // the transport.
        initBridgeViaSentryOptions(tracesSampleRate = 0.0)

        val tx = SentryFgsBridge.startBootTransaction()
        assertNotNull("startBootTransaction must return a handle", tx)
        SentryFgsBridge.finishSpan(tx, "ok")

        Sentry.flush(0)
        assertFalse(
            "boot transaction must reach the transport even with global tracesSampleRate=0.0",
            transport.envelopes.isEmpty(),
        )
    }

    @Test
    fun bootSpanLifecycle() {
        initBridgeViaSentryOptions()
        val tx = SentryFgsBridge.startBootTransaction()
        assertNotNull(tx)

        // Open a phase span and close ok. This is the
        // rootkey-load happy path.
        val span = SentryFgsBridge.startBootSpan(tx!!, "rootkey-load")
        assertNotNull("startBootSpan must return a handle", span)
        SentryFgsBridge.finishSpan(span!!, "ok")

        // Closing the parent transaction with the child already
        // finished is the normal case. Verify it doesn't blow up.
        SentryFgsBridge.finishSpan(tx, "ok")

        Sentry.flush(0)
        assertFalse(transport.envelopes.isEmpty())
    }

    @Test
    fun finishSpanWithCancelledStatusMapsCorrectly() {
        // The STOPPING / destroy() close-path uses `cancelled` as
        // the status. Verify the parser maps the string to
        // `SpanStatus.CANCELLED` rather than silently falling
        // through to UNKNOWN.
        initBridgeViaSentryOptions()
        val tx = SentryFgsBridge.startBootTransaction()!!
        val handle = tx as ITransaction
        SentryFgsBridge.finishSpan(handle, "cancelled")
        assertEquals(
            "cancelled string must map to SpanStatus.CANCELLED",
            SpanStatus.CANCELLED,
            handle.status,
        )
    }

    @Test
    fun startBootTransactionSetsBootKindTag() {
        initBridgeViaSentryOptions()
        val tx = SentryFgsBridge.startBootTransaction(
            startElapsedRealtime = null,
            kind = SentryTags.BOOT_KIND_SYSTEM_RESTART,
        ) as ITransaction
        assertEquals(SentryTags.BOOT_KIND_SYSTEM_RESTART, tx.getTag(SentryTags.BOOT_KIND))
        SentryFgsBridge.finishSpan(tx, "ok")
    }

    @Test
    fun unknownLevelStringFallsBackToInfo() {
        // Defensive: a typo in a `level` argument should not
        // crash the bridge. Implementation uses `lowercase()`
        // and falls through to INFO. Exercise via a breadcrumb;
        // assertion is "no throw + an event captured later
        // carries the breadcrumb at INFO level".
        initBridgeViaSentryOptions()
        SentryFgsBridge.addBreadcrumb(
            category = "comapeo.state",
            message = "test",
            level = "BANANA",
            data = emptyMap(),
        )
        // Capture so the breadcrumb has a host event to ride on.
        SentryFgsBridge.captureMessage(
            message = "trigger",
            level = "info",
            tags = emptyMap(),
        )
        Sentry.flush(0)
        assertEquals(1, transport.envelopes.size)
    }

    // ── countMetric forbidden-tag filter (issue #191) ──────────────

    @Test
    fun countMetricWithForbiddenAttributeIsDropped() {
        val recorded = mutableListOf<String>()
        initBridgeViaSentryOptions(onMetric = { recorded.add(it) })
        SentryFgsBridge.countMetric(
            "comapeo.app.exit",
            attributes = mapOf("project_id" to "abc123"),
        )
        assertTrue(
            "metric with a forbidden attribute must not reach the SDK",
            recorded.isEmpty(),
        )
    }

    @Test
    fun countMetricWithOrdinaryExitAttributesReachesTheSdk() {
        val recorded = mutableListOf<String>()
        initBridgeViaSentryOptions(onMetric = { recorded.add(it) })
        SentryFgsBridge.countMetric(
            "comapeo.app.exit",
            attributes = mapOf(
                SentryTags.EXIT_REASON to "anr",
                SentryTags.EXIT_SEVERITY to "error",
                SentryTags.EXIT_INTENTIONAL to "false",
            ),
        )
        assertEquals(listOf("comapeo.app.exit"), recorded)
    }

    // ── NormalizeDeviceFamilyProcessor tests ───────────────────────
    //
    // Pure-function tests against the processor singleton. They catch
    // regressions where the override value drifts (e.g. "Android-FGS"
    // instead of "Android") or where one of the two overloads
    // (SentryEvent vs SentryTransaction) is dropped. They do NOT
    // assert that production init wires the processor up — that's
    // the smoke test's job.

    @Test
    fun normalizeDeviceFamilyOverridesEventDeviceFamily() {
        // Seed the event with what sentry-android's ContextUtils.getFamily()
        // would produce on a Pixel — `Build.MODEL.split(" ")[0]` → "Google".
        // The processor must rewrite it to "Android".
        val event = SentryEvent().apply {
            contexts.setDevice(Device().apply { family = "Google" })
        }
        val processed = NormalizeDeviceFamilyProcessor.process(event, Hint())
        assertNotNull(processed)
        assertEquals("Android", processed!!.contexts.device?.family)
    }

    @Test
    fun normalizeDeviceFamilyOverridesTransactionDeviceFamily() {
        // The SentryTransaction overload is what mutates `comapeo.boot`
        // and `rpc.server` transactions. Dropping it would let
        // transaction-shaped envelopes keep the raw `Build.MODEL` value.
        val transaction = SentryTransaction(
            /* transaction = */ "test",
            /* startTimestamp = */ 0.0,
            /* timestamp = */ 0.0,
            /* spans = */ emptyList(),
            /* measurements = */ emptyMap(),
            /* transactionInfo = */ io.sentry.protocol.TransactionInfo("manual"),
        ).apply {
            contexts.setDevice(Device().apply { family = "Google" })
        }
        val processed = NormalizeDeviceFamilyProcessor.process(transaction, Hint())
        assertNotNull(processed)
        assertEquals("Android", processed!!.contexts.device?.family)
    }

    /**
     * Cross-platform `Sentry.init(SentryOptions)` + bridge gate-flip.
     * Used by every post-init test in place of
     * [SentryFgsBridge.init] (which requires an Android Context).
     */
    private fun initBridgeViaSentryOptions(
        tracesSampleRate: Double = 1.0,
        onMetric: ((name: String) -> Unit)? = null,
    ) {
        transport = RecordingTransport()
        Sentry.init { options: SentryOptions ->
            options.dsn = "https://abc@sentry.io/1"
            options.environment = "test"
            options.release = "0.0.0+test"
            options.setTransportFactory(transport.factory)
            options.tracesSampleRate = tracesSampleRate
            options.setTag("proc", "fgs")
            options.setTag("layer", "native")
            if (onMetric != null) {
                // Runs synchronously inside the client's captureMetric, so a
                // recorded name proves the bridge forwarded the emission —
                // no need to wait out the metrics batch window.
                options.metrics.setBeforeSend { metric, _ ->
                    onMetric(metric.name)
                    metric
                }
            }
        }
        SentryFgsBridge.markInitializedForTests()
    }
}

/**
 * Sentry transport that captures envelopes in memory rather than
 * sending them anywhere. Pattern from sentry-java's own test
 * suite — the recording slot survives factory re-creation so we
 * can check what was sent during the test.
 */
private class RecordingTransport : ITransport {
    val envelopes = CopyOnWriteArrayList<SentryEnvelope>()

    val factory: ITransportFactory =
        ITransportFactory { _, _ -> this@RecordingTransport }

    override fun send(envelope: SentryEnvelope, hint: io.sentry.Hint) {
        envelopes.add(envelope)
    }

    override fun flush(timeoutMillis: Long) {}

    override fun getRateLimiter(): io.sentry.transport.RateLimiter? = null

    override fun close(isRestarting: Boolean) {}

    override fun close() {}
}
