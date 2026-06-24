package com.comapeo.core

/**
 * Tag keys for Sentry events. Centralised so a typo can't silently route an
 * event to the wrong dashboard column. Values are documented in
 * `docs/sentry-integration-plan.md` and `docs/ARCHITECTURE.md` §7.
 *
 * `proc` reflects the OS process, not a logical layer: iOS is always `main`;
 * Android is `main` for RN/native in the host UI process and `fgs` for code
 * in the `:ComapeoCore` foreground-service process (Kotlin + embedded Node).
 */
object SentryTags {
    const val PROC = "proc"
    const val LAYER = "layer"
    const val PHASE = "comapeo.phase"
    const val STATE = "comapeo.state"
    const val SOURCE = "source"
    const val TIMEOUT = "timeout"

    /** Reliability telemetry for the FGS process-name guard: the value detection
     *  returned in the backend process (or `null`), the manifest-declared name it
     *  was expected to match, and the device API level. */
    const val PROCESS_DETECT_NAME = "comapeo.process_detect.name"
    const val PROCESS_DETECT_EXPECTED = "comapeo.process_detect.expected"
    const val SDK_INT = "comapeo.sdk_int"

    /**
     * On `comapeo.boot` transactions: which start drove this boot. Activity
     * foreground (onResume) and background (onPause, a cold start after the FGS
     * was killed) both carry `serviceStartElapsedMs` + a `boot.fgs-launch` span;
     * system-driven restarts have no intent, stamp, or span. Filter the three
     * populations separately — their timelines are structurally different.
     */
    const val BOOT_KIND = "boot.kind"

    // Historical-exit-reason events (ExitReasonsCollector). Taxonomy in
    // docs/sentry-integration.md.
    const val EXIT_REASON = "exit.reason"
    const val EXIT_PROCESS_STATE = "exit.process_state"
    const val EXIT_SIGNAL = "exit.signal"
    const val EXIT_INTENTIONAL = "exit.intentional"
    /** `error` / `warning` / `info` — kill-class severity as a queryable
     *  attribute (metrics have no event level). */
    const val EXIT_SEVERITY = "exit.severity"
    const val OEM_KILLER_SUSPECTED = "oem.killer.suspected"
    const val FGS_KILLED_IN_BACKGROUND = "comapeo.fgs.killed_in_background"
    const val BG_DURATION_BUCKET = "bg_duration_bucket"
    const val UPTIME_BUCKET = "uptime_bucket"
    /** Boot-time scope tag on pre-API-30 devices (exit reasons unavailable). */
    const val EXIT_REASONS_SUPPORTED = "exitReasons.supported"

    // proc values
    const val PROC_MAIN = "main"
    const val PROC_FGS = "fgs"

    // layer values
    const val LAYER_RN = "rn"
    const val LAYER_NATIVE = "native"
    const val LAYER_NODE = "node"

    // boot.kind values
    const val BOOT_KIND_USER_FOREGROUND = "user-foreground"
    const val BOOT_KIND_USER_BACKGROUND = "user-background"
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
    /** Historical process-exit reporting (ExitReasonsCollector). */
    const val EXIT = "comapeo.exit"
}
