package com.comapeo.core.media

import android.net.LocalServerSocket
import android.net.LocalSocket
import android.net.LocalSocketAddress
import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.comapeo.core.ComapeoCoreService
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.IOException
import java.nio.charset.StandardCharsets
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.random.Random

/**
 * Instrumented tests for [MediaContentProvider], exercised the way real
 * consumers reach it: through `ContentResolver.openInputStream` on a
 * `content://<authority>/...` URI. A fake backend speaking HTTP/1.0 over a
 * FILESYSTEM-namespace Unix socket stands in for the Node.js media server —
 * the provider connects to `filesDir/media.sock`, exactly where the real
 * backend binds.
 */
@RunWith(AndroidJUnit4::class)
class MediaContentProviderTest {

    private lateinit var socketFile: File
    private var serverSocket: LocalServerSocket? = null
    private var boundSocket: LocalSocket? = null
    private val requestLines = CopyOnWriteArrayList<String>()
    @Volatile
    private var serverRunning = true

    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext

    private fun mediaUri(path: String): Uri =
        Uri.parse("content://${MediaContentProvider.authorityFor(context)}$path")

    private var savedRetries = MediaHttpClient.connectRetries

    @Before
    fun setUp() {
        socketFile = File(context.filesDir, ComapeoCoreService.MEDIA_SOCKET_FILENAME)
        socketFile.delete()
        requestLines.clear()
        serverRunning = true
        // Shrink the connect budget so the no-backend test fails in ~300ms
        // instead of sleeping through the production ~15s backoff.
        savedRetries = MediaHttpClient.connectRetries
        MediaHttpClient.connectRetries = 2
    }

    @After
    fun tearDown() {
        MediaHttpClient.connectRetries = savedRetries
        serverRunning = false
        serverSocket?.close()
        boundSocket?.close()
        socketFile.delete()
    }

    /**
     * Fake media server: accepts connections in a loop (the provider opens
     * one connection per request), records the request line, discards the
     * request headers, and replies with [status] + [body], closing the
     * connection to mark end-of-body (HTTP/1.0 framing).
     */
    private fun startFakeMediaServer(
        status: String = "200 OK",
        contentType: String = "application/octet-stream",
        body: ByteArray,
        contentLengthOverride: Int? = null,
    ) {
        val bindSocket = LocalSocket(LocalSocket.SOCKET_STREAM)
        bindSocket.bind(
            LocalSocketAddress(socketFile.absolutePath, LocalSocketAddress.Namespace.FILESYSTEM),
        )
        boundSocket = bindSocket
        serverSocket = LocalServerSocket(bindSocket.fileDescriptor)

        Thread {
            while (serverRunning) {
                val client = try {
                    serverSocket!!.accept()
                } catch (e: IOException) {
                    break // server closed in teardown
                }
                try {
                    val reader = client.inputStream.bufferedReader(StandardCharsets.US_ASCII)
                    val requestLine = reader.readLine() ?: continue
                    requestLines.add(requestLine)
                    while (true) {
                        val line = reader.readLine() ?: break
                        if (line.isEmpty()) break
                    }
                    val head = "HTTP/1.0 $status\r\n" +
                        "Content-Type: $contentType\r\n" +
                        "Content-Length: ${contentLengthOverride ?: body.size}\r\n" +
                        "\r\n"
                    client.outputStream.write(head.toByteArray(StandardCharsets.US_ASCII))
                    client.outputStream.write(body)
                    client.outputStream.flush()
                } catch (e: IOException) {
                    // Client hung up early — fine.
                } finally {
                    try {
                        client.close()
                    } catch (e: IOException) {
                        // Already closed.
                    }
                }
            }
        }.start()
    }

    @Test
    fun streamsServedBytesThroughContentResolver() {
        // Bigger than any single pipe/socket buffer so the test only passes
        // when chunked forwarding works, not just a single lucky read.
        val payload = Random(42).nextBytes(1024 * 1024)
        startFakeMediaServer(contentType = "image/png", body = payload)

        val path = "/blobs/proj123/drive456/photo/original/00aabbccddeeff11"
        val bytes = context.contentResolver.openInputStream(mediaUri(path))!!
            .use { it.readBytes() }

        assertArrayEquals(payload, bytes)
        assertEquals("GET $path HTTP/1.0", requestLines.first())
    }

    @Test
    fun preservesQueryParametersInTheRequestPath() {
        startFakeMediaServer(body = ByteArray(1))

        val path = "/icons/proj123/abcdef/small.png?pixelDensity=2"
        context.contentResolver.openInputStream(mediaUri(path))!!.use { it.readBytes() }

        assertEquals("GET $path HTTP/1.0", requestLines.first())
    }

    @Test
    fun surfacesHttpErrorInsteadOfTruncatedStream() {
        startFakeMediaServer(status = "404 Not Found", body = "not found".toByteArray())

        try {
            context.contentResolver.openInputStream(mediaUri("/blobs/nope"))!!
                .use { it.readBytes() }
            throw AssertionError("expected the stream read to fail")
        } catch (e: IOException) {
            // closeWithError propagates as an IOException from read().
            assertTrue(
                "message should mention the HTTP status, got: ${e.message}",
                e.message?.contains("404") == true,
            )
        }
    }

    @Test
    fun surfacesTruncatedBodyAsError() {
        // Server advertises more bytes than it sends, then closes: an
        // HTTP/1.0 EOF that must NOT be mistaken for completion (a backend
        // dying mid-response looks exactly like this).
        startFakeMediaServer(body = ByteArray(1000), contentLengthOverride = 5000)

        try {
            context.contentResolver.openInputStream(mediaUri("/blobs/cut"))!!
                .use { it.readBytes() }
            throw AssertionError("expected the stream read to fail")
        } catch (e: IOException) {
            assertTrue(
                "message should mention truncation, got: ${e.message}",
                e.message?.contains("Truncated") == true,
            )
        }
    }

    @Test
    fun failsWhenBackendSocketIsAbsent() {
        // No fake server: connect retries exhaust, the provider reports the
        // error through the pipe instead of hanging forever.
        try {
            context.contentResolver.openInputStream(mediaUri("/blobs/x"))!!
                .use { it.readBytes() }
            throw AssertionError("expected the stream read to fail")
        } catch (e: IOException) {
            // Expected: "Could not connect to media socket ...".
        }
    }
}
