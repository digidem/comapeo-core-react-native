package com.comapeo.core

/**
 * Tag keys we set on Sentry events. Centralised so a typo can't
 * silently route an event to the wrong dashboard column. Values
 * are documented in `docs/sentry-integration-plan.md` and
 * `docs/ARCHITECTURE.md` §7.
 *
 * `proc` reflects the actual OS process, not a logical layer:
 * iOS is always `main`; Android is `main` for RN/native code in
 * the host UI process and `fgs` for code in the `:ComapeoCore`
 * foreground-service process (Kotlin FGS code AND the embedded
 * nodejs-mobile that runs there).
 */
object SentryTags {
    const val PROC = "proc"
    const val LAYER = "layer"
    const val PHASE = "comapeo.phase"
    const val STATE = "comapeo.state"
    const val SOURCE = "source"
    const val TIMEOUT = "timeout"

    /**
     * On `comapeo.boot` transactions: distinguishes activity-initiated
     * starts (we have a `serviceStartElapsedMs` stamp from the
     * lifecycle listener) from system-driven restarts after the FGS
     * was killed (intent is null on `onStartCommand`, no stamp, no
     * `boot.fgs-launch` span). The two populations have structurally
     * different timelines and want to be filtered separately.
     */
    const val BOOT_KIND = "boot.kind"

    // proc values
    const val PROC_MAIN = "main"
    const val PROC_FGS = "fgs"

    // layer values
    const val LAYER_RN = "rn"
    const val LAYER_NATIVE = "native"
    const val LAYER_NODE = "node"

    // boot.kind values
    const val BOOT_KIND_USER_FOREGROUND = "user-foreground"
    const val BOOT_KIND_SYSTEM_RESTART = "system-restart"
}

/**
 * Breadcrumb category names. Single source of truth for the
 * dot-separated category strings so a typo can't silently route
 * crumbs to the wrong dashboard filter.
 */
object SentryCategories {
    /** State-machine transitions (STOPPED → STARTING → STARTED …). */
    const val STATE = "comapeo.state"
    /** Control-socket frames (started/ready/stopping/error/malformed). */
    const val CONTROL = "comapeo.control"
    /** FGS (foreground-service) lifecycle (Android only). */
    const val FGS = "comapeo.fgs"
    /** NodeJSIPC connection state transitions. */
    const val IPC = "comapeo.ipc"
    /** Boot phases (start, asset copy, rootkey load, init frame, ready). */
    const val BOOT = "comapeo.boot"
}
