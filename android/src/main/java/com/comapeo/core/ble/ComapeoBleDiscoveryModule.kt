package com.comapeo.core.ble

import android.content.Context
import android.os.Build
import android.util.Base64
import expo.modules.interfaces.permissions.Permissions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * BLE peer discovery — Phase 1 (see docs/ble-discovery.md).
 *
 * Thin transport around [BleAdvertiser] + [BleScanner]: payloads cross
 * the bridge as opaque base64 (the wire format lives in
 * `src/ble/wire-format.ts`), sightings and async radio errors go up as
 * `bleAdvertisement` / `bleError` events. All policy — payload
 * composition, decoding, peer tracking, when to (re)advertise — lives
 * in the JS `BleDiscovery` manager.
 *
 * Runs in the main app process alongside the UI, not in the
 * `:ComapeoCore` FGS: scanning only needs to run while the app is in
 * the foreground for Phase 1, and the advertiser dies with the process
 * exactly when the advertised sync state would go stale anyway.
 * Revisit (move under an FGS with `connectedDevice` type) when
 * background discovery is needed for the Phase 3 hotspot flow.
 */
class ComapeoBleDiscoveryModule : Module() {
    private val advertiser = BleAdvertiser { code, message ->
        emitBleError("advertise", code, message)
    }
    private val scanner = BleScanner(
        onSighting = { payload, rssi, address ->
            sendEvent(
                "bleAdvertisement",
                mapOf(
                    "payload" to Base64.encodeToString(payload, Base64.NO_WRAP),
                    "rssi" to rssi,
                    "address" to address,
                ),
            )
        },
        onError = { code, message -> emitBleError("scan", code, message) },
    )

    private fun emitBleError(scope: String, code: String, message: String) {
        sendEvent(
            "bleError",
            mapOf("scope" to scope, "code" to code, "message" to message),
        )
    }

    private fun requireContext(): Context =
        appContext.reactContext
            ?: throw BleException(
                "ERR_BLE_CONTEXT",
                "BLE call made before the native context attached",
            )

    override fun definition() = ModuleDefinition {
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

        // Starts — or atomically replaces — the advertisement. Runs on
        // the module's async queue; the underlying Android calls are
        // non-blocking (result arrives on the AdvertiseCallback).
        AsyncFunction("startAdvertising") { payloadBase64: String ->
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
            advertiser.start(requireContext(), payload)
        }

        AsyncFunction("stopAdvertising") {
            advertiser.stop()
        }

        AsyncFunction("startScanning") {
            scanner.start(requireContext())
        }

        AsyncFunction("stopScanning") {
            scanner.stop()
        }

        OnDestroy {
            // JS reload or app teardown: stop the radio work; a fresh JS
            // runtime restarts discovery from its own state.
            advertiser.stop()
            scanner.stop()
        }
    }
}
