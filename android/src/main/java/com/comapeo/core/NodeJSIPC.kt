package com.comapeo.core

import android.net.LocalSocket
import android.net.LocalSocketAddress
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout
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
    // Optional first so the trailing-lambda call form
    // `NodeJSIPC(file) { msg -> ... }` keeps binding to `onMessage` (the
    // last function-type parameter). Reordering after `onMessage` would
    // silently capture every existing single-callback callsite as the
    // state observer, which the kotlinc reports as
    // "Argument type mismatch: actual type is 'NodeJSIPC.State', but
    //  'String!' was expected." in CI.
    private val onConnectionStateChange: ((State) -> Unit)? = null,
    private val onMessage: (String) -> Unit,
) {
    private val socketAddress =
        LocalSocketAddress(socketFile.absolutePath, LocalSocketAddress.Namespace.FILESYSTEM)
    private lateinit var socket: LocalSocket
    private var dataOutputStream: DataOutputStream? = null
    private var dataInputStream: DataInputStream? = null
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var connectJob: Job? = null
    private var sendChannel = Channel<String>(Channel.UNLIMITED)

    // Reusable buffers to reduce GC pressure; larger messages use temporary buffers.
    private val receiveLengthBuffer = ByteArray(4)
    private val sendLengthBuffer = ByteArray(4)
    private val receiveMessageBuffer = ByteArray(1024)

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
        if (state.value is State.Error) {
            state.value = State.Disconnected
        }
        if (sendChannel.isClosedForSend) {
            sendChannel = Channel(Channel.UNLIMITED)
        }
        connectJob = scope.launch {
            while (isActive) {
                when (state.value) {
                    is State.Connecting, is State.Connected -> return@launch
                    is State.Disconnecting -> state.first { it is State.Disconnected }
                    is State.Disconnected -> {
                        // Loop on CAS contention from another thread changing the state.
                        if (state.compareAndSet(State.Disconnected, State.Connecting)) break
                    }
                    is State.Error -> state.value = State.Disconnected
                }
            }
            if (::socket.isInitialized) {
                try { socket.close() } catch (_: Exception) {}
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
            receiveMessageBuffer
        } else {
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
            // `shutdown` before `cancelAndJoin`: the receive loop is parked in a
            // blocking `readFully` that `cancelAndJoin` cannot interrupt, so without
            // first waking it the join blocks until the node backend sends a message
            // or closes the socket — a deadlock when node is connected but idle.
            // Same fix as close().
            shutdownSocket()
            connectJob?.cancelAndJoin()
            connectJob = null
            closeStreamsAndSocket()
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

    /**
     * Synchronous, terminal teardown for JS reload (process stays alive, so the
     * fd must be closed here or it leaks until process death). `shutdown` must
     * precede `close`: the receive loop is parked in a blocking `readFully` that
     * holds the socket open until it returns, so `close()` alone never reaches
     * the node backend — `shutdownInput` wakes the read, `shutdownOutput` sends FIN.
     * Not reusable after close; construct a new instance.
     */
    fun close() {
        scope.cancel()
        // Mark terminal before shutdownSocket() wakes the receive loop's blocking
        // readFully: its IOException handler calls disconnect(), which then
        // short-circuits on this state guard instead of relaunching teardown on
        // the now-cancelled scope. Set after scope.cancel() so the (already
        // cancelled) state collector still doesn't forward this transition,
        // matching the prior terminal-close semantics.
        state.value = State.Disconnected
        sendChannel.close()
        shutdownSocket()
        closeStreamsAndSocket()
    }

    // `shutdown` (not `close`) wakes the receive loop parked in a blocking
    // readFully and sends FIN; it must precede closeStreamsAndSocket().
    private fun shutdownSocket() {
        if (::socket.isInitialized) {
            try { socket.shutdownInput() } catch (_: Exception) {}
            try { socket.shutdownOutput() } catch (_: Exception) {}
        }
    }

    private fun closeStreamsAndSocket() {
        try { dataOutputStream?.close() } catch (_: Exception) {}
        try { dataInputStream?.close() } catch (_: Exception) {}
        if (::socket.isInitialized) {
            try { socket.close() } catch (_: Exception) {}
        }
    }
}

/**
 * Connect with a fixed-cadence retry loop bounded by an overall deadline.
 *
 * Retries fire on every `IOException` from `LocalSocket.connect`, which covers
 * both "socket file does not exist yet" (`ENOENT`) and "file exists but the
 * server is not yet `accept`ing" (`ECONNREFUSED`) — the same primitive handles
 * both phases of backend startup. The 50 ms cadence is fast enough to be
 * invisible to TTI; the 30 s deadline matches the prior `waitForFile` timeout
 * so the cumulative startup wait budget is unchanged.
 *
 * No exponential backoff: this is a one-shot startup wait, not a network call,
 * and the failure mode we're tolerating is "backend not finished booting yet"
 * — it doesn't get worse from retrying tightly.
 */
private suspend fun connectWithRetry(
    socketAddress: LocalSocketAddress,
    deadlineMs: Long = 30_000,
    intervalMs: Long = 50,
): LocalSocket {
    var lastFailure: IOException? = null
    var attempts = 0
    val connected = try {
        withTimeout(deadlineMs) {
            // `LocalSocket.connect` opens a real fd before it can throw
            // (`LocalSocketImpl.create` runs before `connectLocal`), so
            // each failed attempt's socket has to be closed before the
            // next iteration — otherwise we'd accumulate hundreds of
            // file descriptors over the deadline window.
            lateinit var s: LocalSocket
            while (true) {
                attempts++
                val candidate = LocalSocket()
                try {
                    candidate.connect(socketAddress)
                    s = candidate
                    break
                } catch (e: IOException) {
                    try { candidate.close() } catch (_: Exception) {}
                    lastFailure = e
                    delay(intervalMs)
                }
            }
            s
        }
    } catch (e: TimeoutCancellationException) {
        // Translate the timeout into an IOException carrying the last
        // connect failure as the cause; otherwise `State.Error` would
        // surface only "Timed out for 30000 ms" with no hint of which
        // syscall was failing or how many attempts ran.
        throw IOException(
            "Timed out connecting to socket after ${deadlineMs}ms across $attempts attempts",
            lastFailure,
        )
    }
    log("Connected on attempt $attempts")
    return connected
}
