package com.comapeo.core.media

import android.net.LocalSocket
import android.net.LocalSocketAddress
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.nio.charset.StandardCharsets

/**
 * Minimal HTTP/1.0 client for the backend's media server, which binds to a
 * Unix domain socket (`media.sock`) inside the app sandbox.
 *
 * HTTP/1.0 is deliberate: it forbids `Transfer-Encoding: chunked`, so the
 * response body is delimited by EOF (the server closes the connection after
 * the payload). That keeps the parser tiny — read the status line and
 * headers, then the rest of the stream is the body. No chunk-decoding state
 * machine. The trade-off is no keep-alive, which is fine because every
 * request opens a fresh UDS connection anyway.
 *
 * Consumers: [MediaContentProvider] (streams bodies into a
 * `ParcelFileDescriptor` pipe for `content://` reads) and the module's
 * `getShareableMediaUrl` (snapshots a body to a cache file for the share
 * sheet).
 */
internal object MediaHttpClient {
    // 8 attempts with 100ms → 5s exponential backoff ≈ 15s of retry: long
    // enough to cover a cold boot still running DB migrations (image loads
    // can legitimately race it, and a failed load is terminal for Fresco,
    // which won't re-fetch a failed URI); bounded so a dead backend
    // surfaces as an error rather than a permanent hang. `var` so
    // connect-failure tests can shrink the budget instead of sleeping
    // through it.
    internal var connectRetries = 8
    private const val CONNECT_INITIAL_DELAY_MS = 100L
    private const val CONNECT_MAX_DELAY_MS = 5000L

    // Mirror of the 64 KiB bound in the iOS MediaFetcher: a runaway server
    // must not make us buffer megabytes of header.
    private const val MAX_HEADER_BYTES = 64 * 1024

    /**
     * An open response. [body] is positioned at the first body byte and
     * reads to EOF; closing the response closes the underlying socket.
     */
    class Response(
        val status: Int,
        /** Header names lower-cased. */
        val headers: Map<String, String>,
        val body: InputStream,
        private val socket: LocalSocket,
    ) : Closeable {
        override fun close() {
            try {
                socket.close()
            } catch (_: IOException) {
                // Already torn down by the peer.
            }
        }
    }

    /**
     * Issues `GET <pathAndQuery>` over [socketFile] and parses the response
     * up to the first body byte. Retries the connect with backoff — image
     * loads can race the backend's boot.
     */
    @Throws(IOException::class)
    fun get(socketFile: File, pathAndQuery: String): Response {
        val socket = connectWithRetry(socketFile)
        try {
            val request = buildString {
                append("GET ").append(pathAndQuery).append(" HTTP/1.0\r\n")
                append("Host: localhost\r\n")
                append("Connection: close\r\n")
                append("\r\n")
            }
            socket.outputStream.write(request.toByteArray(StandardCharsets.US_ASCII))
            socket.outputStream.flush()

            // Buffer once for the whole response: readLine below would
            // otherwise issue one read(2) syscall per header byte, and the
            // body is EOF-delimited on the same stream so read-ahead in the
            // buffer is safe (nothing follows the body).
            val input = BufferedInputStream(socket.inputStream, 8 * 1024)
            var headerBytes = 0
            val boundedReadLine = {
                val line = readLine(input)
                headerBytes += (line?.length ?: 0) + 2
                if (headerBytes > MAX_HEADER_BYTES) {
                    throw IOException("Header section too large")
                }
                line
            }
            val statusLine = boundedReadLine()
                ?: throw IOException("No status line from media socket")
            // "HTTP/1.0 200 OK"
            val parts = statusLine.split(' ', limit = 3)
            val status = parts.getOrNull(1)?.toIntOrNull()
                ?: throw IOException("Malformed status line: $statusLine")

            val headers = mutableMapOf<String, String>()
            while (true) {
                val line = boundedReadLine()
                    ?: throw IOException("Unexpected EOF in headers")
                if (line.isEmpty()) break
                val colon = line.indexOf(':')
                if (colon == -1) continue
                headers[line.substring(0, colon).trim().lowercase()] =
                    line.substring(colon + 1).trim()
            }

            return Response(status, headers, input, socket)
        } catch (e: Exception) {
            try {
                socket.close()
            } catch (_: IOException) {}
            throw e
        }
    }

    /** Reads up to and including CRLF; returns the line without the CRLF, or null at EOF. */
    private fun readLine(input: InputStream): String? {
        val buf = ByteArrayOutputStream()
        var prev = -1
        while (true) {
            val b = input.read()
            if (b == -1) {
                return if (buf.size() == 0) null
                else buf.toString(StandardCharsets.ISO_8859_1.name())
            }
            if (prev == '\r'.code && b == '\n'.code) {
                val raw = buf.toByteArray()
                return String(raw, 0, raw.size - 1, StandardCharsets.ISO_8859_1)
            }
            buf.write(b)
            prev = b
        }
    }

    private fun connectWithRetry(socketFile: File): LocalSocket {
        val addr = LocalSocketAddress(
            socketFile.absolutePath,
            LocalSocketAddress.Namespace.FILESYSTEM,
        )
        var lastError: IOException? = null
        var delayMs = CONNECT_INITIAL_DELAY_MS
        repeat(connectRetries) {
            val socket = LocalSocket()
            try {
                return socket.apply { connect(addr) }
            } catch (e: IOException) {
                // connect() creates the underlying fd before it can fail —
                // close the socket or every failed attempt leaks an fd
                // until GC.
                try {
                    socket.close()
                } catch (_: IOException) {}
                lastError = e
                try {
                    Thread.sleep(delayMs)
                } catch (_: InterruptedException) {
                    Thread.currentThread().interrupt()
                    throw IOException("Interrupted while connecting", e)
                }
                delayMs = (delayMs * 2).coerceAtMost(CONNECT_MAX_DELAY_MS)
            }
        }
        throw IOException(
            "Could not connect to media socket: ${socketFile.absolutePath}",
            lastError,
        )
    }

    /**
     * File extension for a served `Content-Type`, or null when unknown.
     * Blob names have no extension (they're random hex), so share-sheet
     * copies derive one from the header — receiving apps key previews and
     * handlers off it. Deliberately our own table (not `MimeTypeMap`) so
     * it's JVM-testable and byte-identical to the iOS mapping.
     */
    fun extensionForMimeType(mimeType: String?): String? {
        // Strip any "; charset=..." parameter.
        return when (mimeType?.substringBefore(';')?.trim()?.lowercase()) {
            "image/jpeg" -> "jpg"
            "image/png" -> "png"
            "image/gif" -> "gif"
            "image/webp" -> "webp"
            "image/svg+xml" -> "svg"
            "image/heic" -> "heic"
            "video/mp4" -> "mp4"
            "video/quicktime" -> "mov"
            "audio/mpeg" -> "mp3"
            "audio/mp4" -> "m4a"
            "audio/aac" -> "aac"
            "audio/wav", "audio/x-wav" -> "wav"
            "application/pdf" -> "pdf"
            else -> null
        }
    }
}
