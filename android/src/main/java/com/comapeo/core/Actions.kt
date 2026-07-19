package com.comapeo.core

enum class Actions {
    USER_FOREGROUND,
    USER_BACKGROUND,
    STOP,

    /**
     * BLE discovery control, sent by the main-process
     * `ComapeoBleDiscoveryModule` (docs/ble-discovery.md). START and
     * UPDATE_ADVERTISEMENT carry the advertisement payload in the
     * `EXTRA_BLE_PAYLOAD` ByteArray extra (absent = scan-only /
     * stop advertising). Only honoured while the FGS is actually
     * running (`isServiceStarted`) — the engine is useless without the
     * backend the frames flow to.
     */
    BLE_START,
    BLE_UPDATE_ADVERTISEMENT,
    BLE_STOP,

    /**
     * Debug-only: force the running backend into a terminal ERROR with the node
     * thread left alive, exercising the FGS self-terminate watchdog
     * (`ComapeoCoreService.onNodeStateChange`). Handled only when
     * `BuildConfig.DEBUG` is true; a no-op in release. See
     * `NodeJSService.forceFatalErrorForTesting` and `ServiceLifecycleTest`.
     */
    SIMULATE_FATAL_ERROR
}