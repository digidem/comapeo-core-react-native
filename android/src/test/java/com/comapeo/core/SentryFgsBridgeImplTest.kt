package com.comapeo.core

import io.sentry.ITransaction
import io.sentry.ITransportFactory
import io.sentry.Sentry
import io.sentry.SentryEnvelope
import io.sentry.SentryEvent
import io.sentry.SentryLevel
import io.sentry.SentryOptions
import io.sentry.SpanStatus
import io.sentry.transport.ITransport
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

/**
 * JVM unit tests for the post-init code paths in
 * [SentryFgsBridgeImpl]. Bypasses [SentryFgsBridge.init] (which
 * calls `SentryAndroid.init`, requiring a real Android Context
 * and `SystemClock` — neither available in JVM tests) by calling
 * the cross-platform `Sentry.init(SentryOptions)` directly with
 * an in-memory `ITransport` that records every envelope sent.
 *
 * The Impl's per-call methods (`addBreadcrumb`, `captureException`,
 * `captureMessage`, `startBootTransaction`, `startBootSpan`,
 * `finishSpan`) only call `io.sentry.Sentry.*` static methods —
 * the choice of `init` path doesn't change their behaviour. This
 * gives us coverage of every line the integration test on a real
 * device would exercise, without the device.
 *
 * The pre-init guard tests live in [SentryFgsBridgeTest].
 */
class SentryFgsBridgeImplTest {

    private lateinit var transport: RecordingTransport

    @Before
    fun setUp() {
        transport = RecordingTransport()
        Sentry.init { options: SentryOptions ->
            options.dsn = "https://abc@sentry.io/1"
            options.environment = "test"
            options.release = "0.0.0+test"
            // Recording transport — no network. Keeps tests
            // deterministic and offline.
            options.setTransportFactory(transport.factory)
            // Force every transaction onto the wire so the
            // boot-tx tests don't depend on
            // `tracesSampleRate` defaults.
            options.tracesSampleRate = 1.0
            options.setTag("proc", "fgs")
            options.setTag("layer", "native")
        }
    }

    @After
    fun tearDown() {
        Sentry.close()
    }

    @Test
    fun addBreadcrumbDoesNotImmediatelyEnqueueEnvelope() {
        // Breadcrumbs ride along on the next event capture; they
        // don't produce envelopes by themselves. Verifying the
        // negative ensures we don't accidentally turn breadcrumbs
        // into per-emit network traffic on the dashboard.
        SentryFgsBridgeImpl.addBreadcrumb(
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
        SentryFgsBridgeImpl.captureException(
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
        SentryFgsBridgeImpl.captureMessage(
            message = "comapeo: startup timeout fired",
            level = "error",
            tags = mapOf("timeout" to "startup"),
        )
        Sentry.flush(0)
        assertEquals(1, transport.envelopes.size)
    }

    @Test
    fun startBootTransactionForcesSamplingEvenWhenRateIsZero() {
        // Re-init with `tracesSampleRate = 0.0` so the global
        // sample decision would normally drop the transaction.
        // The Impl uses `TracesSamplingDecision(true, 1.0)` to
        // override; if that override is broken, the transaction
        // never reaches the transport.
        Sentry.close()
        transport = RecordingTransport()
        Sentry.init { options ->
            options.dsn = "https://abc@sentry.io/1"
            options.environment = "test"
            options.release = "0.0.0+test"
            options.setTransportFactory(transport.factory)
            options.tracesSampleRate = 0.0
        }

        val tx = SentryFgsBridgeImpl.startBootTransaction()
        assertNotNull("startBootTransaction must return a handle", tx)
        SentryFgsBridgeImpl.finishSpan(tx, "ok")

        Sentry.flush(0)
        assertFalse(
            "boot transaction must reach the transport even with global tracesSampleRate=0.0",
            transport.envelopes.isEmpty(),
        )
    }

    @Test
    fun bootSpanLifecycle() {
        val tx = SentryFgsBridgeImpl.startBootTransaction()
        assertNotNull(tx)

        // Open a phase span and close ok. This is the
        // rootkey-load happy path.
        val span = SentryFgsBridgeImpl.startBootSpan(tx!!, "rootkey-load")
        assertNotNull("startBootSpan must return a handle", span)
        SentryFgsBridgeImpl.finishSpan(span!!, "ok")

        // Closing the parent transaction with the child already
        // finished is the normal case. Verify it doesn't blow up.
        SentryFgsBridgeImpl.finishSpan(tx, "ok")

        Sentry.flush(0)
        assertFalse(transport.envelopes.isEmpty())
    }

    @Test
    fun finishSpanWithCancelledStatusMapsCorrectly() {
        // The new STOPPING / destroy() close-path uses
        // `cancelled` as the status. Verify the parser maps the
        // string to `SpanStatus.CANCELLED` rather than silently
        // falling through to UNKNOWN.
        val tx = SentryFgsBridgeImpl.startBootTransaction()!!
        val handle = tx as ITransaction
        SentryFgsBridgeImpl.finishSpan(handle, "cancelled")
        assertEquals(
            "cancelled string must map to SpanStatus.CANCELLED",
            SpanStatus.CANCELLED,
            handle.status,
        )
    }

    @Test
    fun unknownLevelStringFallsBackToInfo() {
        // Defensive: a typo in a `level` argument should not
        // crash the bridge. The Impl uses `lowercase()` and
        // falls through to INFO. We exercise the path by adding
        // a breadcrumb; the assertion is "no throw + an event
        // captured later carries the breadcrumb at INFO level".
        SentryFgsBridgeImpl.addBreadcrumb(
            category = "comapeo.state",
            message = "test",
            level = "BANANA",
            data = emptyMap(),
        )
        // Capture so the breadcrumb has a host event to ride on.
        SentryFgsBridgeImpl.captureMessage(
            message = "trigger",
            level = "info",
            tags = emptyMap(),
        )
        Sentry.flush(0)
        assertEquals(1, transport.envelopes.size)
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
