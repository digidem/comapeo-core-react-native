package com.comapeo.core.ble

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Handler
import android.os.Looper
import org.json.JSONArray
import org.json.JSONObject

/**
 * The FGS-hosted DNS-SD half of discovery (docs/ble-discovery.md §4b):
 * registers core's local-peer server as `_comapeo._tcp` and browses for
 * peers, using Android's NsdManager. Commanded by the backend's
 * discovery controller (`nsd-start {name, port}` / `nsd-stop` control
 * frames) — replacing the host-app-driven NSD it previously owned, so
 * mDNS discovery now survives backgrounding alongside BLE and the
 * backend.
 *
 * Frames sent to Node:
 * - `nsd-peer {name, address, port}` — a resolved peer service, carrying
 *   its REAL DNS-SD instance name (core's connection-dedup key).
 * - `nsd-peer-lost {name}` — service disappeared.
 * - `nsd-status {browsing, registered, blockers, lastError?}` — mirrors
 *   the BLE engine's status shape.
 *
 * NsdManager quirks handled here: resolution is one-at-a-time (a second
 * concurrent `resolveService` fails with FAILURE_ALREADY_ACTIVE), so
 * found services queue through a serial resolver; all state is confined
 * to the main thread ([handler]) since callbacks arrive on binder
 * threads. NsdManager's known flakiness on some OEM builds is exactly
 * why BLE discovery exists as the complementary path — a broken NSD
 * degrades, it doesn't take discovery down.
 */
class NsdEngine(
    private val context: Context,
    private val sendFrame: (String) -> Unit,
) {
    private val handler = Handler(Looper.getMainLooper())
    private var ownName: String = ""
    private var registrationListener: NsdManager.RegistrationListener? = null
    private var discoveryListener: NsdManager.DiscoveryListener? = null
    private val resolveQueue = ArrayDeque<NsdServiceInfo>()
    private var resolving = false
    private var browsing = "stopped"
    private var registered = "stopped"
    private var lastError: Triple<String, String, String>? = null

    private val nsdManager: NsdManager?
        get() = context.getSystemService(Context.NSD_SERVICE) as? NsdManager

    fun start(name: String, port: Int) {
        handler.post {
            stopLocked()
            ownName = name
            val manager = nsdManager
            if (manager == null) {
                browsing = "unavailable"
                registered = "unavailable"
                lastError = Triple("nsd", "ERR_NSD_UNAVAILABLE", "No NSD service on this device")
                sendStatus()
                return@post
            }
            register(manager, name, port)
            discover(manager)
            sendStatus()
        }
    }

    fun stop() {
        handler.post {
            stopLocked()
            sendStatus()
        }
    }

    // Main-thread only from here down.

    private fun register(manager: NsdManager, name: String, port: Int) {
        val info = NsdServiceInfo().apply {
            serviceName = name
            serviceType = SERVICE_TYPE
            setPort(port)
        }
        lateinit var listener: NsdManager.RegistrationListener
        listener = object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(registeredInfo: NsdServiceInfo) {
                handler.post {
                    // Identity guard: a stale callback from a previous
                    // (stopped/replaced) registration must not flip status or
                    // overwrite `ownName` — which would break self-filtering.
                    if (registrationListener !== listener) return@post
                    // The system renames on collision; track the actual name.
                    ownName = registeredInfo.serviceName ?: ownName
                    registered = "active"
                    sendStatus()
                }
            }

            override fun onRegistrationFailed(info: NsdServiceInfo, errorCode: Int) {
                handler.post {
                    if (registrationListener !== listener) return@post
                    registered = "unavailable"
                    lastError = Triple("register", "ERR_NSD_REGISTER", "code $errorCode")
                    sendStatus()
                }
            }

            override fun onServiceUnregistered(info: NsdServiceInfo) {}

            override fun onUnregistrationFailed(info: NsdServiceInfo, errorCode: Int) {}
        }
        registrationListener = listener
        try {
            manager.registerService(info, NsdManager.PROTOCOL_DNS_SD, listener)
        } catch (e: IllegalArgumentException) {
            registrationListener = null
            registered = "unavailable"
            lastError = Triple("register", "ERR_NSD_REGISTER", e.message ?: "register threw")
        }
    }

    private fun discover(manager: NsdManager) {
        lateinit var listener: NsdManager.DiscoveryListener
        listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) {
                handler.post {
                    if (discoveryListener !== listener) return@post
                    browsing = "active"
                    sendStatus()
                }
            }

            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                handler.post {
                    // Identity guard: without it, a stale failure nulls the
                    // CURRENT `discoveryListener`, so `stopLocked` can never
                    // call `stopServiceDiscovery` on it — a leaked browse.
                    if (discoveryListener !== listener) return@post
                    browsing = "unavailable"
                    discoveryListener = null
                    lastError = Triple("browse", "ERR_NSD_BROWSE", "code $errorCode")
                    sendStatus()
                }
            }

            override fun onDiscoveryStopped(serviceType: String) {}

            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}

            override fun onServiceFound(info: NsdServiceInfo) {
                handler.post {
                    if (discoveryListener !== listener) return@post
                    if (!info.serviceType.contains(SERVICE_TYPE_BARE)) return@post
                    if (info.serviceName == ownName) return@post
                    resolveQueue.add(info)
                    drainResolves()
                }
            }

            override fun onServiceLost(info: NsdServiceInfo) {
                handler.post {
                    if (discoveryListener !== listener) return@post
                    if (info.serviceName == ownName) return@post
                    sendFrame(
                        JSONObject()
                            .put("type", "nsd-peer-lost")
                            .put("name", info.serviceName ?: "")
                            .toString(),
                    )
                }
            }
        }
        discoveryListener = listener
        try {
            manager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
        } catch (e: IllegalArgumentException) {
            discoveryListener = null
            browsing = "unavailable"
            lastError = Triple("browse", "ERR_NSD_BROWSE", e.message ?: "discover threw")
        }
    }

    private fun drainResolves() {
        if (resolving) return
        val manager = nsdManager ?: return
        val info = resolveQueue.removeFirstOrNull() ?: return
        resolving = true
        @Suppress("DEPRECATION") // resolveService: replacement (ServiceInfoCallback) is API 34+
        manager.resolveService(info, object : NsdManager.ResolveListener {
            override fun onServiceResolved(resolved: NsdServiceInfo) {
                handler.post {
                    @Suppress("DEPRECATION") // host: hostAddresses is API 34+
                    val address = resolved.host?.hostAddress
                    if (address != null && resolved.port > 0 && !address.contains(":")) {
                        // IPv4 only — matches the wire format and core's dialer.
                        sendFrame(
                            JSONObject()
                                .put("type", "nsd-peer")
                                .put("name", resolved.serviceName ?: "")
                                .put("address", address)
                                .put("port", resolved.port)
                                .toString(),
                        )
                    }
                    resolving = false
                    drainResolves()
                }
            }

            override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) {
                handler.post {
                    resolving = false
                    drainResolves()
                }
            }
        })
    }

    private fun stopLocked() {
        val manager = nsdManager
        registrationListener?.let { listener ->
            try {
                manager?.unregisterService(listener)
            } catch (_: IllegalArgumentException) {
                // Never registered (register threw / failed) — nothing to undo.
            }
        }
        registrationListener = null
        discoveryListener?.let { listener ->
            try {
                manager?.stopServiceDiscovery(listener)
            } catch (_: IllegalArgumentException) {
                // Discovery never started.
            }
        }
        discoveryListener = null
        resolveQueue.clear()
        resolving = false
        browsing = "stopped"
        registered = "stopped"
    }

    private fun sendStatus() {
        val frame = JSONObject()
            .put("type", "nsd-status")
            .put("browsing", browsing)
            .put("registered", registered)
            .put("blockers", JSONArray())
        lastError?.let { (scope, code, message) ->
            frame.put(
                "lastError",
                JSONObject()
                    .put("scope", scope)
                    .put("code", code)
                    .put("message", message),
            )
        }
        sendFrame(frame.toString())
    }

    companion object {
        const val SERVICE_TYPE = "_comapeo._tcp."
        private const val SERVICE_TYPE_BARE = "_comapeo._tcp"
    }
}
