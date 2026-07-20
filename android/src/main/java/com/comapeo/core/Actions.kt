package com.comapeo.core

enum class Actions {
    USER_FOREGROUND,
    USER_BACKGROUND,
    STOP,

    /**
     * Debug-only: force the running backend into a terminal ERROR with the node
     * thread left alive, exercising the FGS self-terminate watchdog
     * (`ComapeoCoreService.onNodeStateChange`). Handled only when
     * `BuildConfig.DEBUG` is true; a no-op in release. See
     * `NodeJSService.forceFatalErrorForTesting` and `ServiceLifecycleTest`.
     */
    SIMULATE_FATAL_ERROR
}