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
    // Auto-reconnect with backoff after an unexpected socket drop (e.g. the
    // backend process was killed and restarted). Off by default:
    // NodeJSService's usage must not chase a socket it owns the lifecycle of.
    private val reconnectOnDrop: Boolean = false,
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

    // Terminal-close flag: close() sets it before cancelling the scope, so an
    // IO-loop failure racing close() can neither schedule a reconnect (flag)
    // nor run one (reconnects launch in the now-cancelled scope).
    @Volatile
    private var closed = false

    // Incremented on every successful (re)connect; see disconnect(epoch).
    private val connectionEpoch = java.util.concurrent.atomic.AtomicLong(0)

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

    fun connect() = connect(
        deadlineMs = CONNECT_DEADLINE_MS,
        initialIntervalMs = CONNECT_INTERVAL_MS,
        maxIntervalMs = CONNECT_INTERVAL_MS,
    )

    private fun connect(deadlineMs: Long, initialIntervalMs: Long, maxIntervalMs: Long) {
        if (closed) {
            return
        }
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
                socket = connectWithRetry(
                    socketAddress,
                    deadlineMs,
                    initialIntervalMs,
                    maxIntervalMs,
                ).apply {
                    dataOutputStream = DataOutputStream(outputStream)
                    dataInputStream = DataInputStream(inputStream)
                }
            } catch (e: Exception) {
                    log("Failed to connect to socket: ${e.message}")
                    state.value = State.Error(e)
                    return@launch
            }
            // close() may have won while connectWithRetry was between suspension
            // points; don't overwrite its terminal Disconnected with Connected.
            if (closed) {
                closeStreamsAndSocket()
                return@launch
            }

            val epoch = connectionEpoch.incrementAndGet()
            state.value = State.Connected
            val receiveJob = launch {
                while (isActive) {
                    try {
                        receiveMessage()
                    } catch (e: IOException) {
                        // break, don't retry: a second disconnect() from this
                        // loop can outlive the teardown+reconnect it triggers
                        // and would tear down the replacement connection.
                        disconnect(epoch)
                        break
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
                        disconnect(epoch)
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

    fun disconnect() = disconnect(ANY_EPOCH)

    // `epoch` scopes the teardown to one connection: the IO loops pass the epoch
    // of the connection that failed, so a disconnect that runs late — after a
    // reconnect has already replaced that connection — returns instead of tearing
    // down the replacement (State.Connected is a singleton, so the state CAS
    // alone cannot tell two connections apart). Public disconnect() passes
    // ANY_EPOCH: a deliberate teardown targets whatever connection is current.
    private fun disconnect(epoch: Long) {
        if (state.value is State.Disconnecting || state.value is State.Disconnected) {
            return
        }
        // Teardown is single-flight: concurrent disconnect calls (send + receive
        // loops failing together) all launch jobs, but only the one that wins the
        // Connected -> Disconnecting CAS tears down and runs the completion side
        // effects; losers return without touching state or scheduling a reconnect.
        val wonTeardown = java.util.concurrent.atomic.AtomicBoolean(false)
        val disconnectJob = scope.launch {
            while (isActive) {
                when (state.value) {
                    is State.Disconnecting, is State.Disconnected -> return@launch
                    is State.Connecting -> {
                        state.first { it is State.Connected || it is State.Error }
                    }
                    is State.Connected -> {
                        if (epoch != ANY_EPOCH && connectionEpoch.get() != epoch) return@launch
                        if (state.compareAndSet(State.Connected, State.Disconnecting)) {
                            // Epoch can advance between the check above and the
                            // CAS (full teardown + reconnect in the gap). Once
                            // Disconnecting is ours the epoch is frozen, so this
                            // re-read is authoritative: on mismatch we captured
                            // the replacement connection — hand it back untouched.
                            if (epoch != ANY_EPOCH && connectionEpoch.get() != epoch) {
                                state.value = State.Connected
                                return@launch
                            }
                            wonTeardown.set(true)
                            break
                        }
                    }
                    is State.Error -> {
                        state.value = State.Disconnected
                        return@launch
                    }
                }
            }
            // Close the channel only after winning the CAS: a losing (stale)
            // disconnect must not close the replacement connection's channel —
            // trySend on a closed channel drops messages silently.
            sendChannel.close()
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
            if (!wonTeardown.get()) return@invokeOnCompletion
            state.value = when (cause) {
                null, is EOFException, is IOException, is CancellationException -> State.Disconnected
                else -> State.Error(cause)
            }
            // Terminal teardown goes through close(), so a disconnect() that
            // completes with `closed` unset is an unexpected drop (the IO loops'
            // IOException handlers) — the auto-reconnect trigger. Backoff, not
            // the 50ms cold-start cadence: a backend restart takes seconds.
            if (reconnectOnDrop && !closed) {
                log("Unexpected disconnect; auto-reconnecting with backoff")
                connect(
                    deadlineMs = RECONNECT_DEADLINE_MS,
                    initialIntervalMs = RECONNECT_INITIAL_INTERVAL_MS,
                    maxIntervalMs = RECONNECT_MAX_INTERVAL_MS,
                )
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
        closed = true
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

// Explicit connect(): 50 ms cadence is invisible to TTI; the 30 s deadline
// matches the prior `waitForFile` timeout so the startup wait budget is unchanged.
private const val CONNECT_DEADLINE_MS = 30_000L
private const val CONNECT_INTERVAL_MS = 50L

// disconnect(epoch) wildcard: tear down the current connection, whichever it is.
private const val ANY_EPOCH = -1L

// Auto-reconnect after an unexpected drop: a killed backend process takes a few
// seconds to be restarted by the system, so back off instead of burning battery
// on a tight loop, and give up (State.Error) after a bounded window.
private const val RECONNECT_DEADLINE_MS = 60_000L
private const val RECONNECT_INITIAL_INTERVAL_MS = 250L
private const val RECONNECT_MAX_INTERVAL_MS = 4_000L

/**
 * Connect with a retry loop bounded by an overall deadline.
 *
 * Retries fire on every `IOException` from `LocalSocket.connect`, which covers
 * both "socket file does not exist yet" (`ENOENT`) and "file exists but the
 * server is not yet `accept`ing" (`ECONNREFUSED`) — the same primitive handles
 * both phases of backend startup, and a stale socket file left behind by a
 * killed backend process.
 *
 * The interval between attempts starts at [initialIntervalMs] and doubles up to
 * [maxIntervalMs]. Cold-start callers pass equal values (fixed cadence — a
 * startup wait doesn't get worse from retrying tightly); the auto-reconnect
 * path passes a widening backoff because the peer needs seconds to come back.
 */
private suspend fun connectWithRetry(
    socketAddress: LocalSocketAddress,
    deadlineMs: Long,
    initialIntervalMs: Long,
    maxIntervalMs: Long,
): LocalSocket {
    var lastFailure: IOException? = null
    var attempts = 0
    var intervalMs = initialIntervalMs
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
                    intervalMs = (intervalMs * 2).coerceAtMost(maxIntervalMs)
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
