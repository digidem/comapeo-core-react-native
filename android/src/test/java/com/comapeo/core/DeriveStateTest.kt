package com.comapeo.core

import com.comapeo.core.NodeJSService.BackendState
import com.comapeo.core.NodeJSService.ExitReason
import com.comapeo.core.NodeJSService.NodeRuntimeState
import com.comapeo.core.NodeJSService.State
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * JVM-only unit tests for [NodeJSService.deriveState]. The derivation
 * function is the heart of the per-component lifecycle model — every
 * public state transition lands by computing this function over the
 * (NodeRuntime, BackendState, stopRequested) triple.
 *
 * Coverage rationale: behavioural / instrumented tests exercise the
 * derivation indirectly via real start/stop flows, but they leave
 * most cells of the truth table untouched. These tests pin the table
 * directly so a regression that flips one cell doesn't have to sneak
 * through a behavioural test that happens to exercise it.
 */
class DeriveStateTest {

    // Call the top-level helper directly rather than going through
    // `NodeJSService.deriveState`. The companion-object delegate
    // would do the same thing, but accessing a static method on
    // `NodeJSService` triggers its companion init — including
    // `System.loadLibrary("comapeo-core-react-native")`, which has
    // no `.so` on the host JVM. The pure derivation needs to be
    // reachable without the JNI library.
    private fun derive(
        n: NodeRuntimeState,
        b: BackendState,
        stop: Boolean = false,
    ): State = deriveLifecycleState(
        nodeRuntime = n,
        backendState = b,
        stopRequested = stop,
    )

    // MARK: - Rule 1: backend-reported error wins over everything

    @Test
    fun backendErrorAlwaysDerivesError() {
        val backendErr = BackendState.Error(phase = "construct", message = "boom")
        assertEquals(State.ERROR, derive(NodeRuntimeState.NotRunning, backendErr))
        assertEquals(State.ERROR, derive(NodeRuntimeState.Running, backendErr))
        assertEquals(
            State.ERROR,
            derive(NodeRuntimeState.Exited(code = 0, reason = ExitReason.REQUESTED), backendErr),
        )
        assertEquals(
            State.ERROR,
            derive(NodeRuntimeState.Exited(code = 1, reason = ExitReason.UNEXPECTED), backendErr),
        )
        // Even with stop intent — backend error is louder.
        assertEquals(State.ERROR, derive(NodeRuntimeState.NotRunning, backendErr, stop = true))
    }

    // MARK: - Rule 2: unexpected runtime exit derives ERROR

    @Test
    fun unexpectedRuntimeExitDerivesError() {
        val exitedUnexpected = NodeRuntimeState.Exited(code = 1, reason = ExitReason.UNEXPECTED)
        // Across the BackendState variants that aren't Error.
        assertEquals(State.ERROR, derive(exitedUnexpected, BackendState.Unknown))
        assertEquals(State.ERROR, derive(exitedUnexpected, BackendState.ControlBound))
        assertEquals(State.ERROR, derive(exitedUnexpected, BackendState.Ready))
        assertEquals(State.ERROR, derive(exitedUnexpected, BackendState.Stopping))
        // Unexpected exit outranks stop intent — if the runtime
        // crashed, that's ERROR, not "we wanted it gone so call it stopped".
        assertEquals(State.ERROR, derive(exitedUnexpected, BackendState.Ready, stop = true))
    }

    // MARK: - Rule 3: stop intent

    @Test
    fun stopIntentWithRuntimeGoneDerivesStopped() {
        assertEquals(State.STOPPED, derive(NodeRuntimeState.NotRunning, BackendState.Unknown, stop = true))
        assertEquals(
            State.STOPPED,
            derive(
                NodeRuntimeState.Exited(code = 0, reason = ExitReason.REQUESTED),
                BackendState.Ready,
                stop = true,
            ),
        )
        assertEquals(
            State.STOPPED,
            derive(
                NodeRuntimeState.Exited(code = 0, reason = ExitReason.REQUESTED),
                BackendState.Stopping,
                stop = true,
            ),
        )
    }

    @Test
    fun stopIntentWithRuntimeRunningDerivesStopping() {
        assertEquals(State.STOPPING, derive(NodeRuntimeState.Running, BackendState.Ready, stop = true))
        assertEquals(State.STOPPING, derive(NodeRuntimeState.Running, BackendState.ControlBound, stop = true))
        assertEquals(State.STOPPING, derive(NodeRuntimeState.Running, BackendState.Stopping, stop = true))
    }

    // MARK: - Rule 4: backend stopping

    @Test
    fun backendStoppingDerivesStopping() {
        assertEquals(State.STOPPING, derive(NodeRuntimeState.Running, BackendState.Stopping))
        assertEquals(State.STOPPING, derive(NodeRuntimeState.NotRunning, BackendState.Stopping))
    }

    // MARK: - Rule 5: ready

    @Test
    fun backendReadyDerivesStarted() {
        assertEquals(State.STARTED, derive(NodeRuntimeState.Running, BackendState.Ready))
    }

    // MARK: - Rule 6: starting

    @Test
    fun runningOrControlBoundDerivesStarting() {
        assertEquals(State.STARTING, derive(NodeRuntimeState.Running, BackendState.Unknown))
        assertEquals(State.STARTING, derive(NodeRuntimeState.Running, BackendState.ControlBound))
        // Edge case: backend bound but runtime not yet running (shouldn't
        // happen in practice; derivation still says STARTING).
        assertEquals(State.STARTING, derive(NodeRuntimeState.NotRunning, BackendState.ControlBound))
    }

    // MARK: - Rule 7: default → STOPPED

    @Test
    fun defaultPathDerivesStopped() {
        assertEquals(State.STOPPED, derive(NodeRuntimeState.NotRunning, BackendState.Unknown))
        assertEquals(
            State.STOPPED,
            derive(
                NodeRuntimeState.Exited(code = 0, reason = ExitReason.REQUESTED),
                BackendState.Unknown,
            ),
        )
    }

    // MARK: - Sanity: STARTED → STOPPING → STOPPED graceful path

    @Test
    fun gracefulShutdownDerivationSequence() {
        // STARTED: runtime running, backend ready.
        assertEquals(State.STARTED, derive(NodeRuntimeState.Running, BackendState.Ready, stop = false))
        // stop() called → STOPPING (intent + still running).
        assertEquals(State.STOPPING, derive(NodeRuntimeState.Running, BackendState.Ready, stop = true))
        // Backend acknowledges with stopping frame → still STOPPING.
        assertEquals(State.STOPPING, derive(NodeRuntimeState.Running, BackendState.Stopping, stop = true))
        // Runtime exits cleanly → STOPPED.
        assertEquals(
            State.STOPPED,
            derive(
                NodeRuntimeState.Exited(code = 0, reason = ExitReason.REQUESTED),
                BackendState.Stopping,
                stop = true,
            ),
        )
    }
}
