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
    SIMULATE_FATAL_ERROR,

    /**
     * Test seam for the e2e app (`maestro/fgs-restart-frontend.yaml`): kill the
     * FGS process without `stopSelf`, so `START_STICKY` cold-restarts it while
     * the main RN process stays alive — the exact production failure the
     * frontend-restart path guards against. Handled only when the host app is
     * the e2e app (see `ComapeoCoreService.E2E_APP_PACKAGE`); a no-op otherwise.
     */
    SIMULATE_PROCESS_KILL
}