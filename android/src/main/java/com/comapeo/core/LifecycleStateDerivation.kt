package com.comapeo.core

/**
 * Pure derivation of [NodeJSService.State] from the three component states.
 *
 * Lives at top level (not on [NodeJSService.Companion]) so JVM unit tests can
 * call it without triggering the companion's `System.loadLibrary` init —
 * the `.so` is unavailable off-device and would crash any test touching the
 * derivation.
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
