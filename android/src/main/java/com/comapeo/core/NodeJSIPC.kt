package com.comapeo.core

import android.net.LocalSocket
import android.net.LocalSocketAddress
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.ByteOrder


class NodeJSIPC(private val socketFile: File, private val onMessage: (ByteArray) -> Unit) {
    private val socketAddress =
        LocalSocketAddress(socketFile.absolutePath, LocalSocketAddress.Namespace.FILESYSTEM)
    private lateinit var socket: LocalSocket
    private var dataOutputStream: DataOutputStream? = null
    private var dataInputStream: DataInputStream? = null
    private val scope = CoroutineScope(Dispatchers.IO + Job())
    private var receiveJob: Job? = null
    private val sendMutex = Mutex()

    init {
        log("NodeJSIPC initialized with socket file: ${socketFile.absolutePath}")
        scope.launch {
            try {
                // Wait for the socket file to be created
                waitForFile(socketFile)
                onServerReady()
            } catch (e: IllegalArgumentException) {
                log("File has no parent directory: ${socketFile.absolutePath}, ${e.message}")
            } catch (e: Exception) {
                log("Unexpected error: ${e.message}")
            }
        }
    }

    fun disconnect() {
        socket.close()
    }

    fun sendMessage(message: ByteArray) {
        scope.launch {
            sendMutex.withLock {
                dataOutputStream?.let { out ->
                    val lengthBuffer =
                        ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(message.size)
                            .array()
                    out.write(lengthBuffer)
                    out.write(message)
                    out.flush()
                } ?: throw IllegalStateException("Socket not connected")
            }
        }
    }

    private fun onServerReady() {
        socket = LocalSocket().apply {
            connect(socketAddress)
            dataOutputStream = DataOutputStream(outputStream)
            dataInputStream = DataInputStream(inputStream)
        }

        // Start receiving messages
        receiveJob = scope.launch {
            try {
                while (isActive) {
                    val lengthBuffer = ByteArray(4)
                    dataInputStream?.readFully(lengthBuffer)
                    val messageLength =
                        ByteBuffer.wrap(lengthBuffer).order(ByteOrder.LITTLE_ENDIAN).int
                    val message = ByteArray(messageLength)
                    dataInputStream?.readFully(message)
                    onMessage(message)
                }
            } catch (e: IOException) {
                // Handle disconnect
            }
        }
    }

}
