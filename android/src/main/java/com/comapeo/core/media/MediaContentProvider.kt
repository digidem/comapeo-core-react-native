package com.comapeo.core.media

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.net.LocalSocket
import android.net.LocalSocketAddress
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.webkit.MimeTypeMap
import com.comapeo.core.ComapeoCoreService
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.io.InputStream
import java.nio.charset.StandardCharsets
import java.util.concurrent.Executors

/**
 * Exposes the backend's blob/icon HTTP server (bound to a Unix domain socket
 * inside the app sandbox) as `content://` URIs.
 *
 * The backend Fastify server listens on `media.sock` in the same `filesDir`
 * the dual-process foreground service writes to. This provider runs in the
 * main app process; both processes share `filesDir`, so the path is
 * deterministic on both sides.
 *
 * `openFile()` returns the read-end of a pipe whose write-end is fed by an
 * HTTP/1.0 request issued over the UDS on a worker thread. HTTP/1.0 is
 * deliberate: it forbids `Transfer-Encoding: chunked`, so the response body
 * is delimited by EOF (i.e. the server closes the connection after the
 * payload). That keeps the parser tiny — we read until the blank line ends
 * the headers, then `copyTo` the rest. No chunk-decoding state machine.
 *
 * The provider is declared as `exported="false"` (only this app can target
 * it) and `grantUriPermissions="true"` so a future share-sheet path can hand
 * a one-shot read grant to another app via `Intent.FLAG_GRANT_READ_URI_PERMISSION`.
 */
class MediaContentProvider : ContentProvider() {
    companion object {
        const val AUTHORITY_SUFFIX = ".comapeo.media"

        /** Returns this provider's authority for the given app `Context`. */
        fun authorityFor(context: Context): String =
            context.packageName + AUTHORITY_SUFFIX

        private const val CONNECT_RETRIES = 5
        private const val CONNECT_INITIAL_DELAY_MS = 100L
        private const val CONNECT_MAX_DELAY_MS = 5000L
        private const val PIPE_COPY_BUFFER = 64 * 1024
    }

    /**
     * One thread per concurrent media stream. Each request blocks reading
     * the HTTP response and writing the pipe's far end, so a coroutine
     * dispatcher would just turn into one-OS-thread-per-request anyway.
     * `cachedThreadPool` reuses idle threads and reaps them after 60 s, which
     * matches the bursty access pattern of an image-heavy list view.
     */
    private val executor = Executors.newCachedThreadPool { r ->
        Thread(r, "comapeo-media-stream").apply { isDaemon = true }
    }

    override fun onCreate(): Boolean = true

    override fun getType(uri: Uri): String? {
        val ext = MimeTypeMap.getFileExtensionFromUrl(uri.toString())
        if (ext.isNullOrEmpty()) return "application/octet-stream"
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext)
            ?: "application/octet-stream"
    }

    @Throws(FileNotFoundException::class)
    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        if (mode != "r") {
            throw FileNotFoundException("Only mode 'r' is supported (got '$mode')")
        }

        val ctx = context
            ?: throw FileNotFoundException("Provider has no context")
        val socketFile = File(ctx.filesDir, ComapeoCoreService.MEDIA_SOCKET_FILENAME)

        val pathAndQuery = buildString {
            append(uri.encodedPath ?: "/")
            uri.encodedQuery?.let { append("?").append(it) }
        }

        val pipe = ParcelFileDescriptor.createReliablePipe()
        val readSide = pipe[0]
        val writeSide = pipe[1]

        executor.execute {
            try {
                streamHttpResponse(socketFile, pathAndQuery, writeSide)
            } catch (e: Exception) {
                // Surface the failure to the consumer instead of silently
                // truncating the stream — Glide / Fresco will treat a closed
                // pipe with no error as an "incomplete file" warning, which
                // is harder to diagnose than an explicit error message.
                try {
                    writeSide.closeWithError(e.message ?: "media stream error")
                } catch (_: IOException) {
                    // Read side already closed — nothing to report to.
                }
            }
        }

        return readSide
    }

    private fun streamHttpResponse(
        socketFile: File,
        pathAndQuery: String,
        writeSide: ParcelFileDescriptor,
    ) {
        ParcelFileDescriptor.AutoCloseOutputStream(writeSide).use { out ->
            connectWithRetry(socketFile).use { localSocket ->
                val request = buildString {
                    // HTTP/1.0 — forbids Transfer-Encoding: chunked, so the
                    // response body is just bytes-until-EOF. See class doc.
                    append("GET ").append(pathAndQuery).append(" HTTP/1.0\r\n")
                    append("Host: localhost\r\n")
                    append("Connection: close\r\n")
                    append("\r\n")
                }
                localSocket.outputStream.write(
                    request.toByteArray(StandardCharsets.US_ASCII)
                )
                localSocket.outputStream.flush()

                val input = localSocket.inputStream
                val status = readStatusAndDiscardHeaders(input)
                if (status !in 200..299) {
                    throw FileNotFoundException("HTTP $status for $pathAndQuery")
                }

                input.copyTo(out, PIPE_COPY_BUFFER)
            }
        }
    }

    /**
     * Reads the status line and headers, leaving `input` positioned at the
     * first body byte. Returns the numeric status code.
     */
    private fun readStatusAndDiscardHeaders(input: InputStream): Int {
        val statusLine = readLine(input)
            ?: throw IOException("No status line from media socket")
        // "HTTP/1.0 200 OK"
        val parts = statusLine.split(' ', limit = 3)
        if (parts.size < 2) throw IOException("Malformed status line: $statusLine")
        val status = parts[1].toIntOrNull()
            ?: throw IOException("Malformed status code: $statusLine")
        while (true) {
            val line = readLine(input) ?: throw IOException("Unexpected EOF in headers")
            if (line.isEmpty()) break
        }
        return status
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
            LocalSocketAddress.Namespace.FILESYSTEM
        )
        var lastError: IOException? = null
        var delayMs = CONNECT_INITIAL_DELAY_MS
        repeat(CONNECT_RETRIES) {
            try {
                return LocalSocket().apply { connect(addr) }
            } catch (e: IOException) {
                lastError = e
                try { Thread.sleep(delayMs) } catch (_: InterruptedException) {
                    Thread.currentThread().interrupt()
                    throw IOException("Interrupted while connecting", e)
                }
                delayMs = (delayMs * 2).coerceAtMost(CONNECT_MAX_DELAY_MS)
            }
        }
        throw IOException(
            "Could not connect to media socket: ${socketFile.absolutePath}",
            lastError
        )
    }

    // Read-only provider. ContentResolver only reaches the methods below
    // when callers issue query/insert/etc., which never happens for image
    // loads — those go through openFile / openInputStream.
    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): Cursor? = null

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, s: String?, sa: Array<out String>?): Int = 0
    override fun update(
        uri: Uri,
        values: ContentValues?,
        selection: String?,
        selectionArgs: Array<out String>?,
    ): Int = 0
}
