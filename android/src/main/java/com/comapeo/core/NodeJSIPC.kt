package com.comapeo.core

import android.net.LocalSocket
import android.net.LocalSocketAddress
import android.os.Build
import androidx.annotation.RequiresApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.io.IOException
import java.nio.file.FileSystems
import java.nio.file.Path
import java.nio.file.Paths
import java.nio.file.StandardWatchEventKinds


class NodeJSIPC(private val socketFile: File, private val onMessage: (ByteArray) -> Unit) {
    private val socketAddress =
        LocalSocketAddress(socketFile.absolutePath, LocalSocketAddress.Namespace.FILESYSTEM)
    private lateinit var socket: LocalSocket
    private var dataOutputStream: DataOutputStream? = null
    private var dataInputStream: DataInputStream? = null
    private val scope = CoroutineScope(Dispatchers.IO + Job())
    private var receiveJob: Job? = null

    init {
        // TODO: Support API level 24
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            watchForServerReady(::onServerReady)
        }
    }

    fun disconnect() {
        socket.close()
    }

    fun sendMessage(message: ByteArray) {
        scope.launch {
            dataOutputStream?.let { out ->
                out.writeInt(message.size)
                out.write(message)
                out.flush()
            } ?: throw IllegalStateException("Socket not connected")
        }
    }

    fun onServerReady() {
        socket = LocalSocket().apply {
            connect(socketAddress)
            dataOutputStream = DataOutputStream(outputStream)
            dataInputStream = DataInputStream(inputStream)
        }

        // Start receiving messages
        receiveJob = scope.launch {
            try {
                while (isActive) {
                    val messageLength = dataInputStream?.readInt() ?: break
                    val message = ByteArray(messageLength)
                    dataInputStream?.readFully(message)
                    onMessage(message)
                }
            } catch (e: IOException) {
                // Handle disconnect
            }
        }
    }

    @RequiresApi(Build.VERSION_CODES.O)
    private fun watchForServerReady(
        onServerReady: () -> Unit
    ): Job {
        val scope = CoroutineScope(Dispatchers.IO + Job())

        if (socketFile.exists()) {
            println("Server is already ready!")
            onServerReady()
            return Job() // Return a completed Job
        }

        val path = Paths.get(socketFile.parent)
        val fileName = socketFile.name

        return scope.launch {
            try {
                FileSystems.getDefault().newWatchService().use { watchService ->
                    path.register(watchService, StandardWatchEventKinds.ENTRY_CREATE)
                    println("Waiting for server to be ready...")

                    while (isActive) { // Check if the coroutine is still active
                        val key = watchService.take() // Blocks until an event is available
                        key.pollEvents().forEach { event ->
                            val eventPath = event.context() as Path
                            if (event.kind() == StandardWatchEventKinds.ENTRY_CREATE && eventPath.toString() == fileName) {
                                println("Server is ready!")
                                onServerReady()
                                return@launch
                            }
                        }
                        key.reset()
                    }
                }
            } catch (e: Exception) {
                println("Error watching for server readiness: ${e.message}")
            }
        }
    }
}