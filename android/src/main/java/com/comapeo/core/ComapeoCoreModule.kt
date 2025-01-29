package com.comapeo.core

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

class ComapeoCoreModule : Module() {
    private lateinit var ipc: NodeJSIPC

    // Each module class must implement the definition function. The definition consists of components
    // that describes the module's functionality and behavior.
    // See https://docs.expo.dev/modules/module-api for more details about available components.
    override fun definition() = ModuleDefinition {
        OnCreate {
            val socketFile =
                File(appContext.persistentFilesDirectory, ComapeoCoreService.SOCKET_FILENAME)
            ipc = NodeJSIPC(socketFile) { message ->
                log("Received message: ${message.decodeToString()}")
                sendEvent("messageReceived", mapOf("data" to message.decodeToString()))
            }
        }
        // Sets the name of the module that JavaScript code will use to refer to the module. Takes a string as an argument.
        // Can be inferred from module's class name, but it's recommended to set it explicitly for clarity.
        // The module will be accessible from `requireNativeModule('ComapeoCore')` in JavaScript.
        Name("ComapeoCore")

        // Sets constant properties on the module. Can take a dictionary or a closure that returns a dictionary.
        Constants(
            "PI" to Math.PI
        )

        // Defines event names that the module can send to JavaScript.
        Events("messageReceived")

        // Defines a JavaScript synchronous function that runs the native code on the JavaScript thread.
        Function("sendMessage") { message: String ->
            ipc.sendMessage(message.encodeToByteArray())
        }
    }
}
