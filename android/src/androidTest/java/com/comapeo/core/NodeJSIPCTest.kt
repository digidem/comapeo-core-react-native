package com.comapeo.core

import android.net.LocalServerSocket
import android.net.LocalSocket
import android.net.LocalSocketAddress
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Instrumented tests for [NodeJSIPC].
 *
 * These tests create a local mock server socket bound to the FILESYSTEM
 * namespace (matching how NodeJSIPC connects) to test the IPC protocol
 * in isolation, without needing a real Node.js process.
 */
@RunWith(AndroidJUnit4::class)
class NodeJSIPCTest {

    private lateinit var socketFile: File
    private var serverSocket: LocalServerSocket? = null
    private var boundSocket: LocalSocket? = null
    private val receivedMessages = CopyOnWriteArrayList<String>()

    @Before
    fun setUp() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        socketFile = File(context.filesDir, "test_ipc_${System.nanoTime()}.sock")
        socketFile.delete() // ensure clean state
        receivedMessages.clear()
    }

    @After
    fun tearDown() {
        serverSocket?.close()
        boundSocket?.close()
        socketFile.delete()
    }

    // --- Helpers ---

    /**
     * Creates a server socket bound to the FILESYSTEM namespace at [socketFile].
     *
     * [LocalServerSocket(String)] only supports the abstract namespace, but
     * [NodeJSIPC] connects using [LocalSocketAddress.Namespace.FILESYSTEM].
     * To match, we bind a [LocalSocket] to the filesystem address and pass
     * its file descriptor to [LocalServerSocket].
     */
    private fun bindServer(): LocalServerSocket {
        val bindSocket = LocalSocket(LocalSocket.SOCKET_STREAM)
        val address = LocalSocketAddress(socketFile.absolutePath, LocalSocketAddress.Namespace.FILESYSTEM)
        bindSocket.bind(address)
        boundSocket = bindSocket
        serverSocket = LocalServerSocket(bindSocket.fileDescriptor)
        return serverSocket!!
    }

    private fun startMockServer(onConnection: (DataInputStream, DataOutputStream) -> Unit) {
        val server = bindServer()

        Thread {
            try {
                val client = server.accept()
                val input = DataInputStream(client.inputStream)
                val output = DataOutputStream(client.outputStream)
                onConnection(input, output)
            } catch (e: IOException) {
                // Server closed, expected during teardown
            }
        }.start()
    }

    /**
     * Write a length-prefixed JSON message to the output stream (server side).
     */
    private fun writeFramedMessage(output: DataOutputStream, message: String) {
        val bytes = message.toByteArray(Charsets.UTF_8)
        val lengthBytes = ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(bytes.size).array()
        output.write(lengthBytes)
        output.write(bytes)
        output.flush()
    }

    /**
     * Read a length-prefixed JSON message from the input stream (server side).
     */
    private fun readFramedMessage(input: DataInputStream): String {
        val lengthBytes = ByteArray(4)
        input.readFully(lengthBytes)
        val length = ByteBuffer.wrap(lengthBytes).order(ByteOrder.LITTLE_ENDIAN).int
        val messageBytes = ByteArray(length)
        input.readFully(messageBytes)
        return String(messageBytes, Charsets.UTF_8)
    }

    // --- Tests ---

    @Test
    fun connectsToExistingSocket() {
        val connected = CountDownLatch(1)

        startMockServer { _, _ ->
            connected.countDown()
            // Keep connection alive
            Thread.sleep(2000)
        }

        val ipc = NodeJSIPC(socketFile) { msg -> receivedMessages.add(msg) }

        assertTrue("Should connect within 10s", connected.await(10, TimeUnit.SECONDS))
        ipc.disconnect()
    }

    @Test
    fun sendsMessageWithCorrectFraming() {
        val messageReceived = CountDownLatch(1)
        var serverReceivedMessage = ""

        startMockServer { input, _ ->
            serverReceivedMessage = readFramedMessage(input)
            messageReceived.countDown()
        }

        val ipc = NodeJSIPC(socketFile) { msg -> receivedMessages.add(msg) }

        // Wait for connection before sending
        Thread.sleep(1000)
        ipc.sendMessage("""{"type":"test","data":"hello"}""")

        assertTrue("Server should receive message within 5s", messageReceived.await(5, TimeUnit.SECONDS))
        assertEquals("""{"type":"test","data":"hello"}""", serverReceivedMessage)
        ipc.disconnect()
    }

    @Test
    fun receivesMessageWithCorrectFraming() {
        val messageReceived = CountDownLatch(1)

        startMockServer { _, output ->
            // Give client time to connect and set up receive loop
            Thread.sleep(500)
            writeFramedMessage(output, """{"type":"response","id":42}""")
            // Keep connection alive for receive
            Thread.sleep(2000)
        }

        val ipc = NodeJSIPC(socketFile) { msg ->
            receivedMessages.add(msg)
            messageReceived.countDown()
        }

        assertTrue("Should receive message within 5s", messageReceived.await(5, TimeUnit.SECONDS))
        assertEquals(1, receivedMessages.size)
        assertEquals("""{"type":"response","id":42}""", receivedMessages[0])
        ipc.disconnect()
    }

    @Test
    fun handlesRoundTripEcho() {
        val echoReceived = CountDownLatch(1)

        startMockServer { input, output ->
            // Echo server: read a message and send it back
            val msg = readFramedMessage(input)
            writeFramedMessage(output, msg)
            Thread.sleep(2000)
        }

        val ipc = NodeJSIPC(socketFile) { msg ->
            receivedMessages.add(msg)
            echoReceived.countDown()
        }

        Thread.sleep(1000)
        ipc.sendMessage("""{"echo":"ping"}""")

        assertTrue("Should receive echo within 5s", echoReceived.await(5, TimeUnit.SECONDS))
        assertEquals("""{"echo":"ping"}""", receivedMessages[0])
        ipc.disconnect()
    }

    @Test
    fun handlesMultipleMessages() {
        val messageCount = 100
        val allReceived = CountDownLatch(messageCount)

        startMockServer { input, output ->
            // Echo server for N messages
            repeat(messageCount) {
                try {
                    val msg = readFramedMessage(input)
                    writeFramedMessage(output, msg)
                } catch (e: IOException) {
                    return@startMockServer
                }
            }
            Thread.sleep(2000)
        }

        val ipc = NodeJSIPC(socketFile) { msg ->
            receivedMessages.add(msg)
            allReceived.countDown()
        }

        Thread.sleep(1000)
        repeat(messageCount) { i ->
            ipc.sendMessage("""{"id":$i}""")
        }

        assertTrue(
            "Should receive all $messageCount messages within 30s",
            allReceived.await(30, TimeUnit.SECONDS)
        )
        assertEquals(messageCount, receivedMessages.size)
        ipc.disconnect()
    }

    @Test
    fun handlesLargeMessages() {
        val largePayload = "x".repeat(64 * 1024) // 64KB - well over the 1KB reuse buffer
        val received = CountDownLatch(1)

        startMockServer { _, output ->
            Thread.sleep(500)
            writeFramedMessage(output, """{"data":"$largePayload"}""")
            Thread.sleep(2000)
        }

        val ipc = NodeJSIPC(socketFile) { msg ->
            receivedMessages.add(msg)
            received.countDown()
        }

        assertTrue("Should receive large message within 10s", received.await(10, TimeUnit.SECONDS))
        assertTrue("Message should contain large payload", receivedMessages[0].contains(largePayload))
        ipc.disconnect()
    }

    @Test
    fun waitsForSocketFileCreation() {
        // Don't start the server yet - the socket file doesn't exist
        val connected = CountDownLatch(1)

        val ipc = NodeJSIPC(socketFile) { msg -> receivedMessages.add(msg) }

        // Start the server after a delay, creating the socket file
        Thread {
            Thread.sleep(2000)
            startMockServer { _, _ ->
                connected.countDown()
                Thread.sleep(5000)
            }
        }.start()

        assertTrue(
            "Should connect after socket file appears within 10s",
            connected.await(10, TimeUnit.SECONDS)
        )
        ipc.disconnect()
    }

    @Test
    fun disconnectClosesCleanly() {
        val connected = CountDownLatch(1)

        startMockServer { _, _ ->
            connected.countDown()
            Thread.sleep(5000)
        }

        val ipc = NodeJSIPC(socketFile) { msg -> receivedMessages.add(msg) }
        assertTrue("Should connect within 10s", connected.await(10, TimeUnit.SECONDS))

        // Disconnect should not throw
        ipc.disconnect()

        // Let disconnect complete
        Thread.sleep(500)
    }

    /**
     * Pins the synchronous-close contract: after [NodeJSIPC.close] returns, the
     * peer's blocking read has already observed EOF. A regression to the
     * `disconnect()` teardown — which closes the socket behind
     * `cancelAndJoin()` of a receive loop parked in a blocking `readFully` —
     * would deadlock and leave the read blocked, leaking the FD across reloads.
     */
    @Test
    fun closeReleasesSocketSynchronously() {
        val connected = CountDownLatch(1)
        val readResult = java.util.concurrent.atomic.AtomicInteger(Int.MIN_VALUE)
        val readReturned = CountDownLatch(1)

        startMockServer { input, _ ->
            connected.countDown()
            try {
                readResult.set(input.read())
            } catch (e: IOException) {
                // Some kernels surface peer-close as IOException; treat as EOF.
                readResult.set(-1)
            }
            readReturned.countDown()
        }

        val ipc = NodeJSIPC(socketFile) { msg -> receivedMessages.add(msg) }
        assertTrue("Should connect within 10s", connected.await(10, TimeUnit.SECONDS))
        // Let the receive loop settle so we test steady-state close, not a
        // connect-cancel race.
        Thread.sleep(200)

        ipc.close()

        assertTrue(
            "Server-side read must unblock with EOF within 1s of close() returning",
            readReturned.await(1, TimeUnit.SECONDS)
        )
        assertEquals(-1, readResult.get())
    }

    @Test
    fun handlesServerDisconnect() {
        val connected = CountDownLatch(1)
        val serverDone = CountDownLatch(1)

        startMockServer { _, _ ->
            connected.countDown()
            // Close immediately to simulate server disconnect
            Thread.sleep(500)
            serverDone.countDown()
        }

        val ipc = NodeJSIPC(socketFile) { msg -> receivedMessages.add(msg) }
        assertTrue("Should connect within 10s", connected.await(10, TimeUnit.SECONDS))

        // Wait for server to close its end
        assertTrue("Server should close within 5s", serverDone.await(5, TimeUnit.SECONDS))

        // Give the IPC time to detect the disconnection
        Thread.sleep(2000)

        // The IPC should handle the server disconnect without crashing
        ipc.disconnect()
    }

    /**
     * With reconnectOnDrop enabled, an unexpected server-side close followed by
     * the server accepting again must converge back to a working connection
     * without any sendMessage()/connect() nudge — the low-memory-kill recovery
     * path where the FGS process restarts a few seconds later.
     */
    @Test
    fun reconnectsAfterUnexpectedServerDrop() {
        val server = bindServer()
        val firstAccepted = CountDownLatch(1)
        val received = CountDownLatch(1)

        Thread {
            try {
                val first = server.accept()
                firstAccepted.countDown()
                Thread.sleep(300)
                first.close() // unexpected drop
                val second = server.accept()
                Thread.sleep(300) // let the reconnected client's receive loop attach
                writeFramedMessage(
                    DataOutputStream(second.outputStream),
                    """{"type":"after-reconnect"}""",
                )
                Thread.sleep(5000)
            } catch (e: IOException) {
                // Server closed, expected during teardown
            }
        }.start()

        val ipc = NodeJSIPC(socketFile, reconnectOnDrop = true) { msg ->
            receivedMessages.add(msg)
            received.countDown()
        }
        try {
            assertTrue("Should connect within 10s", firstAccepted.await(10, TimeUnit.SECONDS))
            assertTrue(
                "Should auto-reconnect and receive within 15s",
                received.await(15, TimeUnit.SECONDS)
            )
            assertEquals("""{"type":"after-reconnect"}""", receivedMessages[0])
        } finally {
            ipc.close()
        }
    }

    @Test
    fun closeSuppressesReconnect() {
        val server = bindServer()
        val acceptCount = java.util.concurrent.atomic.AtomicInteger(0)
        // Retain every accepted socket: an unreferenced LocalSocket can be
        // GC-finalized (closed) mid-test, dropping the connection and causing
        // a spurious reconnect before close() is even called.
        val acceptedSockets = CopyOnWriteArrayList<LocalSocket>()

        Thread {
            try {
                while (true) {
                    acceptedSockets.add(server.accept())
                    acceptCount.incrementAndGet()
                }
            } catch (e: IOException) {
                // Server closed, expected during teardown
            }
        }.start()

        val ipc = NodeJSIPC(socketFile, reconnectOnDrop = true) { msg ->
            receivedMessages.add(msg)
        }
        val deadline = System.currentTimeMillis() + 10_000
        while (acceptCount.get() == 0 && System.currentTimeMillis() < deadline) {
            Thread.sleep(50)
        }
        assertEquals("Should connect once", 1, acceptCount.get())
        Thread.sleep(200)

        ipc.close()

        // Longer than several backoff steps (immediate + 250 + 500 + 1000ms); a
        // post-close reconnect would show up as a second accept.
        Thread.sleep(3000)
        assertEquals("close() must not trigger reconnect attempts", 1, acceptCount.get())
        acceptedSockets.forEach { try { it.close() } catch (_: IOException) {} }
    }

    @Test
    fun doesNotReconnectByDefaultAfterUnexpectedDrop() {
        val server = bindServer()
        val acceptCount = java.util.concurrent.atomic.AtomicInteger(0)

        Thread {
            try {
                while (true) {
                    val client = server.accept()
                    acceptCount.incrementAndGet()
                    Thread.sleep(300)
                    client.close() // unexpected drop
                }
            } catch (e: IOException) {
                // Server closed, expected during teardown
            }
        }.start()

        val ipc = NodeJSIPC(socketFile) { msg -> receivedMessages.add(msg) }
        try {
            val deadline = System.currentTimeMillis() + 10_000
            while (acceptCount.get() == 0 && System.currentTimeMillis() < deadline) {
                Thread.sleep(50)
            }
            assertEquals("Should connect once", 1, acceptCount.get())

            // Ample time for an (unwanted) reconnect after the drop at +300ms.
            Thread.sleep(3000)
            assertEquals(
                "Default (reconnectOnDrop=false) must not reconnect",
                1,
                acceptCount.get()
            )
        } finally {
            ipc.close()
        }
    }
}
