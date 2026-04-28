package com.comapeo.core

import android.net.LocalSocket
import android.net.LocalSocketAddress
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.EOFException
import java.io.File
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.ByteOrder


@OptIn(ExperimentalCoroutinesApi::class)
class NodeJSIPC(
    private val socketFile: File,
    private val onMessage: (String) -> Unit,
    private val onConnectionStateChange: ((State) -> Unit)? = null,
) {
    private val socketAddress =
        LocalSocketAddress(socketFile.absolutePath, LocalSocketAddress.Namespace.FILESYSTEM)
    private lateinit var socket: LocalSocket
    private var dataOutputStream: DataOutputStream? = null
    private var dataInputStream: DataInputStream? = null
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var connectJob: Job? = null
    private var sendChannel = Channel<String>(Channel.UNLIMITED)

    // Reusable buffers to reduce GC pressure
    private val receiveLengthBuffer = ByteArray(4)
    private val sendLengthBuffer = ByteArray(4)
    private var receiveMessageBuffer = ByteArray(1024) // Larger messages use temporary buffers

    sealed class State {
        data object Connecting : State()
        data object Connected : State()
        data object Disconnected : State()
        data object Disconnecting : State()
        data class Error(val exception: Throwable) : State()
    }

    private val state = MutableStateFlow<State>(State.Disconnected)
    val connectionState: State get() = state.value

    init {
        log("NodeJSIPC initialized with socket file: ${socketFile.absolutePath}")
        // Forward subsequent state transitions to the optional observer.
        // The very first observation is the initial Disconnected state, which
        // is uninteresting; consumers care about transitions, not the seed
        // value, so we skip that emission.
        onConnectionStateChange?.let { callback ->
            scope.launch {
                var seenFirst = false
                state.collect {
                    if (seenFirst) callback(it) else seenFirst = true
                }
            }
        }
        connect()
    }

    fun connect() {
        if (state.value is State.Connected || state.value is State.Connecting) {
            return
        }
        // Allow reconnection from error state
        if (state.value is State.Error) {
            state.value = State.Disconnected
        }
        // Create fresh send channel if previous was closed
        if (sendChannel.isClosedForSend) {
            sendChannel = Channel(Channel.UNLIMITED)
        }
        connectJob = scope.launch {
            while (isActive) {
                when (state.value) {
                    is State.Connecting, is State.Connected -> return@launch
                    is State.Disconnecting -> {
                        state.first { it is State.Disconnected }
                    }
                    is State.Disconnected -> {
                        if (state.compareAndSet(State.Disconnected, State.Connecting)) {
                            break
                        }
                        // Loop continues if another thread changed the state before we could set it
                    }
                    is State.Error -> {
                        // Reset to disconnected to allow reconnection
                        state.value = State.Disconnected
                    }
                }
            }
            waitForFile(socketFile)
            if (::socket.isInitialized) {
                try {
                    socket.close()
                } catch (e: Exception) {
                    // Ignore exceptions when closing - socket might already be closed
                }
            }
            try {
                socket = connectWithRetry(socketAddress).apply {
                    dataOutputStream = DataOutputStream(outputStream)
                    dataInputStream = DataInputStream(inputStream)
                }
            } catch (e: Exception) {
                    log("Failed to connect to socket: ${e.message}")
                    state.value = State.Error(e)
                    return@launch
            }

            state.value = State.Connected
            val receiveJob = launch {
                while (isActive) {
                    try {
                        receiveMessage()
                    } catch (e: IOException) {
                        disconnect()
                    }
                }
            }
            receiveJob.invokeOnCompletion { cause ->
                log("Receive job completed with cause: $cause")
            }
            val sendJob = launch {
                for (message in sendChannel) {
                    try {
                        sendMessageInternal(message)
                    } catch (e: IOException) {
                        log("Send failed, disconnecting: ${e.message}")
                        disconnect()
                        break
                    }
                }
            }
            sendJob.invokeOnCompletion { cause ->
                log("Send job completed with cause: $cause")
            }
        }
        connectJob?.invokeOnCompletion { cause ->
            log("Connect job completed with cause: $cause")
        }
    }

    private fun receiveMessage() {
        dataInputStream?.readFully(receiveLengthBuffer)
        val messageLength =
            ByteBuffer.wrap(receiveLengthBuffer).order(ByteOrder.LITTLE_ENDIAN).int

        val buffer = if (messageLength <= receiveMessageBuffer.size) {
            // Reuse fixed buffer for small messages
            receiveMessageBuffer
        } else {
            // Allocate temporary buffer for large messages
            ByteArray(messageLength)
        }

        dataInputStream?.readFully(buffer, 0, messageLength)
        onMessage(buffer.decodeToString(0, messageLength))
    }

    fun disconnect() {
        if (state.value is State.Disconnecting || state.value is State.Disconnected) {
            return
        }
        sendChannel.close()
        val disconnectJob = scope.launch {
            while (isActive) {
                when (state.value) {
                    is State.Disconnecting, is State.Disconnected -> return@launch
                    is State.Connecting -> {
                        state.first { it is State.Connected || it is State.Error }
                    }
                    is State.Connected -> {
                        if (state.compareAndSet(State.Connected, State.Disconnecting)) {
                            break
                        }
                    }
                    is State.Error -> {
                        state.value = State.Disconnected
                        return@launch
                    }
                }
            }
            connectJob?.cancelAndJoin()
            connectJob = null
            try { dataOutputStream?.close() } catch (_: Exception) {}
            try { dataInputStream?.close() } catch (_: Exception) {}
            try { socket.close() } catch (_: Exception) {}
        }
        disconnectJob.invokeOnCompletion { cause ->
            state.value = when (cause) {
                null, is EOFException, is IOException, is CancellationException -> State.Disconnected
                else -> State.Error(cause)
            }
        }
    }

    private suspend fun sendMessageInternal(message: String) {
        val messageBytes = message.encodeToByteArray()
        state.first { it is State.Connected }
        dataOutputStream?.let { out ->
            // Reuse sendLengthBuffer for writing length prefix
            ByteBuffer.wrap(sendLengthBuffer).order(ByteOrder.LITTLE_ENDIAN).putInt(messageBytes.size)
            out.write(sendLengthBuffer)
            out.write(messageBytes)
        } ?: throw IOException("Socket not connected")
    }

    fun sendMessage(message: String) {
        connect()
        sendChannel.trySend(message)
    }
}

private suspend fun connectWithRetry(
    socketAddress: LocalSocketAddress,
    maxRetries: Int = 5,
    initialDelayMs: Long = 100,
    maxDelayMs: Long = 5000,
    backoffMultiplier: Double = 2.0
): LocalSocket {
    var currentDelay = initialDelayMs
    var lastException: IOException? = null

    repeat(maxRetries) { attempt ->
        try {
            val socket = LocalSocket()
            socket.connect(socketAddress)
            log("Connected on attempt ${attempt + 1}")
            return socket
        } catch (e: IOException) {
            lastException = e

            if (attempt < maxRetries - 1) {
                delay(currentDelay)
                currentDelay = minOf(
                    (currentDelay * backoffMultiplier).toLong(),
                    maxDelayMs
                )
            }
        }
    }

    throw IOException(
        "Failed to connect after $maxRetries attempts",
        lastException
    )
}
