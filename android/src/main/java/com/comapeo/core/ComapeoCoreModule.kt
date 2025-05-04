package com.comapeo.core

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.*
import android.content.ServiceConnection
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.IBinder
import kotlinx.coroutines.flow.asStateFlow

class ComapeoCoreModule : Module() {
    private lateinit var ipc: NodeJSIPC

    private val _serviceState = MutableStateFlow(ServiceState.STOPPED)
    private val serviceState = _serviceState.asStateFlow()

    private var myService: IService? = null
    private val scope = CoroutineScope(Dispatchers.Main + Job())

    private val serviceCallback = object : IServiceCallback.Stub() {
        override fun onStateChanged(state: Int) {
            scope.launch(Dispatchers.Main) {
                _serviceState.value = ServiceState.entries.toTypedArray()[state]
            }
        }
    }

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
            myService = IService.Stub.asInterface(service)
            // Get initial state
            val currentState = myService?.getCurrentState() ?: 0
            _serviceState.value = ServiceState.entries.toTypedArray()[currentState]
            myService?.registerCallback(serviceCallback)
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            myService?.unregisterCallback(serviceCallback)
            myService = null
            _serviceState.value = ServiceState.STOPPED
        }
    }

    // Each module class must implement the definition function. The definition consists of components
    // that describes the module's functionality and behavior.
    // See https://docs.expo.dev/modules/module-api for more details about available components.
    override fun definition() = ModuleDefinition {
        OnCreate {
            val socketFile =
                File(appContext.persistentFilesDirectory, ComapeoCoreService.COMAPEO_SOCKET_FILENAME)
            ipc = NodeJSIPC(socketFile) { message ->
                sendEvent("message", mapOf("data" to message.decodeToString()))
            }
            scope.launch {
                serviceState.collect {
                    sendEvent("stateChange", mapOf("state" to it.name))
                }
            }
            Intent(appContext.reactContext, ComapeoCoreService::class.java).also { intent ->
                appContext.reactContext?.bindService(intent, connection, Context.BIND_AUTO_CREATE)
            }
        }

        OnDestroy {
            appContext.reactContext?.unbindService(connection)
            ipc.disconnect()
        }


        // Sets the name of the module that JavaScript code will use to refer to the module. Takes a string as an argument.
        // Can be inferred from module's class name, but it's recommended to set it explicitly for clarity.
        // The module will be accessible from `requireNativeModule('ComapeoCore')` in JavaScript.
        Name("ComapeoCore")

        // Defines event names that the module can send to JavaScript.
        Events("message", "stateChange")

        // Defines a JavaScript synchronous function that runs the native code on the JavaScript thread.
        Function("postMessage") { message: String ->
            ipc.sendMessage(message.encodeToByteArray())
        }

        Function ("getState") {
            return@Function serviceState.value.name
        }
    }
}
