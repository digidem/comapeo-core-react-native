package com.comapeo.core

/**
 * Pure derivation of [NodeJSService.State] from the three component
 * states defined as nested types on [NodeJSService].
 *
 * Lives at top level (not in [NodeJSService.Companion]) so JVM unit
 * tests can call it from the `test` source set without triggering
 * the companion object's `System.loadLibrary("comapeo-core-react-native")`
 * init — that load fails on the host JVM (no `.so` available outside
 * an Android device or emulator) and would otherwise crash any test
 * that touches the derivation.
 *
 * Decision order (top to bottom — earlier matches win):
 * 1. Any backend-reported error → ERROR.
 * 2. An unexpected runtime exit → ERROR.
 * 3. A stop has been requested → STOPPED if the runtime is gone,
 *    STOPPING otherwise.
 * 4. Backend announced `stopping` → STOPPING.
 * 5. Backend reached `ready` → STARTED.
 * 6. Runtime is running OR backend reached `controlBound` → STARTING.
 * 7. Otherwise → STOPPED.
 */
internal fun deriveLifecycleState(
    nodeRuntime: NodeJSService.NodeRuntimeState,
    backendState: NodeJSService.BackendState,
    stopRequested: Boolean,
): NodeJSService.State {
    if (backendState is NodeJSService.BackendState.Error) return NodeJSService.State.ERROR
    if (nodeRuntime is NodeJSService.NodeRuntimeState.Exited &&
        nodeRuntime.reason == NodeJSService.ExitReason.UNEXPECTED) {
        return NodeJSService.State.ERROR
    }

    if (stopRequested) {
        return when (nodeRuntime) {
            NodeJSService.NodeRuntimeState.NotRunning,
            is NodeJSService.NodeRuntimeState.Exited -> NodeJSService.State.STOPPED
            else -> NodeJSService.State.STOPPING
        }
    }
    if (backendState is NodeJSService.BackendState.Stopping) return NodeJSService.State.STOPPING
    if (backendState is NodeJSService.BackendState.Ready) return NodeJSService.State.STARTED

    if (nodeRuntime is NodeJSService.NodeRuntimeState.Running) return NodeJSService.State.STARTING
    if (backendState is NodeJSService.BackendState.ControlBound) return NodeJSService.State.STARTING

    return NodeJSService.State.STOPPED
}
