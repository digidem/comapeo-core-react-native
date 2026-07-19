package com.comapeo.core.ble

import android.content.Intent
import android.os.Build
import android.util.Base64
import com.comapeo.core.Actions
import com.comapeo.core.ComapeoCoreService
import com.comapeo.core.ControlFrame
import com.comapeo.core.NodeJSIPC
import com.comapeo.core.log
import expo.modules.interfaces.permissions.Permissions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

/**
 * JS-facing controller for BLE peer discovery (docs/ble-discovery.md).
 *
 * This module owns **no radios**. They live in [BleDiscoveryEngine]
 * inside the `:ComapeoCore` foreground service, so advertising and
 * scanning survive the app being backgrounded or this (main) process
 * being killed — the same reason the Node backend lives there. What
 * this module does:
 *
 * - **Control**: `startDiscovery` / `updateAdvertisement` /
 *   `stopDiscovery` are forwarded to the FGS as service intents
 *   ([Actions.BLE_START] etc.). The desired state is kept here and
 *   re-pushed whenever the backend (re)announces `started`/`ready`, so
 *   an FGS respawn transparently resumes discovery.
 * - **Observation**: a read-only control-socket client. The backend
 *   re-broadcasts accepted sightings as `ble-peer` frames and radio
 *   failures as `ble-error`; those surface here as the
 *   `bleAdvertisement` / `bleError` events the JS `BleDiscovery`
 *   manager consumes. (While this process is dead, nobody listens —
 *   but the backend keeps auto-connecting peers; the UI view simply
 *   resumes on the next foreground.)
 * - **Permissions**: the runtime-permission dialogs need an Activity,
 *   which only exists in this process.
 *
 * Radio errors are therefore asynchronous (`bleError` events), never
 * rejections of the start call — an intent has no reply channel.
 */
class ComapeoBleDiscoveryModule : Module() {
    private lateinit var controlIpc: NodeJSIPC

    /** Backend reachable: control socket up and `started`/`ready` seen.
     *  Gates intent sends so a BLE intent can't cold-spawn the FGS process. */
    @Volatile
    private var backendUp = false

    /** Desired-state cache for resume-after-FGS-respawn. Guarded: JS calls
     *  arrive on the module queue, `started` frames on an IPC coroutine. */
    private val desiredLock = Any()
    private var desiredActive = false
    private var desiredPayload: ByteArray? = null

    override fun definition() = ModuleDefinition {
        OnCreate {
            val controlSocketFile = File(
                appContext.persistentFilesDirectory,
                ComapeoCoreService.CONTROL_SOCKET_FILENAME,
            )
            // Own read-only observer (the core module has its own): the control
            // socket supports any number of clients and replays `started`/`ready`
            // on connect, so both converge independently.
            controlIpc = NodeJSIPC(
                controlSocketFile,
                onMessage = { message ->
                    when (val frame = ControlFrame.parse(message)) {
                        ControlFrame.Started, ControlFrame.Ready -> {
                            backendUp = true
                            resendDesired()
                        }
                        ControlFrame.Stopping -> backendUp = false
                        is ControlFrame.BlePeer -> sendEvent(
                            "bleAdvertisement",
                            mapOf(
                                "payload" to frame.payload,
                                "rssi" to frame.rssi,
                                "address" to frame.address,
                            ),
                        )
                        is ControlFrame.BleError -> sendEvent(
                            "bleError",
                            mapOf(
                                "scope" to frame.scope,
                                "code" to frame.code,
                                "message" to frame.message,
                            ),
                        )
                        // Lifecycle/error/sentry frames belong to the core module.
                        else -> {}
                    }
                },
                onConnectionStateChange = { state ->
                    when (state) {
                        is NodeJSIPC.State.Disconnected,
                        is NodeJSIPC.State.Error,
                        -> backendUp = false
                        else -> {}
                    }
                },
            )
        }

        OnDestroy {
            controlIpc.close()
        }

        OnActivityEntersForeground {
            // Idempotent, mirrors ComapeoCoreModule: recovers the observer
            // socket after a transient FGS respawn.
            controlIpc.connect()
        }

        Name("ComapeoBleDiscovery")

        Events("bleAdvertisement", "bleError")

        Function("getCapabilities") {
            val adapter = appContext.reactContext?.let(BleAdvertiser::bluetoothAdapter)
            mapOf(
                "available" to (adapter != null),
                "enabled" to (adapter?.let(BleAdvertiser::isEnabledSafe) ?: false),
            )
        }

        AsyncFunction("getPermissionsAsync") { promise: Promise ->
            Permissions.getPermissionsWithPermissionsManager(
                appContext.permissions,
                promise,
                *BlePermissions.required(Build.VERSION.SDK_INT),
            )
        }

        AsyncFunction("requestPermissionsAsync") { promise: Promise ->
            Permissions.askForPermissionsWithPermissionsManager(
                appContext.permissions,
                promise,
                *BlePermissions.required(Build.VERSION.SDK_INT),
            )
        }

        // Start scanning (and advertising when a payload is given). Resolves
        // once the intent is dispatched — radio failures arrive as `bleError`
        // events. If the backend isn't up yet, the desired state is stored
        // and pushed when it announces `started`.
        AsyncFunction("startDiscovery") { payloadBase64: String? ->
            val payload = payloadBase64?.let(::decodePayload)
            synchronized(desiredLock) {
                desiredActive = true
                desiredPayload = payload
            }
            if (backendUp) sendBleIntent(Actions.BLE_START, payload)
        }

        // Replace (or with null clear) the advertisement without touching the
        // scan. No-op until `startDiscovery` has been called.
        AsyncFunction("updateAdvertisement") { payloadBase64: String? ->
            val payload = payloadBase64?.let(::decodePayload)
            val active = synchronized(desiredLock) {
                desiredPayload = payload
                desiredActive
            }
            if (active && backendUp) {
                sendBleIntent(Actions.BLE_UPDATE_ADVERTISEMENT, payload)
            }
        }

        AsyncFunction("stopDiscovery") {
            synchronized(desiredLock) {
                desiredActive = false
                desiredPayload = null
            }
            if (backendUp) sendBleIntent(Actions.BLE_STOP, null)
        }
    }

    /** Re-push the desired state after the backend (re)starts, so an FGS
     *  respawn resumes discovery without host-app involvement. */
    private fun resendDesired() {
        val (active, payload) = synchronized(desiredLock) {
            desiredActive to desiredPayload
        }
        if (active) sendBleIntent(Actions.BLE_START, payload)
    }

    private fun sendBleIntent(action: Actions, payload: ByteArray?) {
        val ctx = appContext.reactContext
            ?: throw BleException(
                "ERR_BLE_CONTEXT",
                "BLE call made before the native context attached",
            )
        val intent = Intent(ctx, ComapeoCoreService::class.java).setAction(action.name)
        payload?.let { intent.putExtra(ComapeoCoreService.EXTRA_BLE_PAYLOAD, it) }
        try {
            ctx.startService(intent)
        } catch (e: IllegalStateException) {
            // Background-start restriction: the app is backgrounded AND the FGS
            // is down (a running FGS lifts the restriction). The desired state
            // is retained; the next `started` frame re-pushes it.
            log("BLE intent ${action.name} deferred: ${e.message}")
        }
    }

    private fun decodePayload(payloadBase64: String): ByteArray {
        val payload = try {
            Base64.decode(payloadBase64, Base64.DEFAULT)
        } catch (e: IllegalArgumentException) {
            throw BleException("ERR_BLE_PAYLOAD", "Payload is not valid base64")
        }
        if (payload.size > BleProtocol.MAX_PAYLOAD_LENGTH) {
            throw BleException(
                "ERR_BLE_PAYLOAD",
                "Payload is ${payload.size} bytes; legacy advertisements cap " +
                    "manufacturer data at ${BleProtocol.MAX_PAYLOAD_LENGTH}",
            )
        }
        return payload
    }
}
