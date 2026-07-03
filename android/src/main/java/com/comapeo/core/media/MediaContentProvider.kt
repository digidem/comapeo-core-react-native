package com.comapeo.core.media

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import com.comapeo.core.ComapeoCoreService
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/**
 * Exposes the backend's blob/icon HTTP server (bound to a Unix domain
 * socket inside the app sandbox) as `content://` URIs, so React Native's
 * `<Image>` (Fresco handles `content://` natively) can stream media without
 * the backend ever opening a TCP port other apps could reach.
 *
 * The backend's Fastify server listens on `media.sock` in the same
 * `filesDir` the dual-process foreground service writes to. This provider
 * runs in the main app process; both processes share `filesDir`, so the
 * path is deterministic on both sides.
 *
 * `openFile()` returns the read-end of a pipe whose write-end is fed by an
 * HTTP/1.0 request issued over the UDS on a worker thread (see
 * [MediaHttpClient] for why HTTP/1.0). Bytes are forwarded chunk by chunk,
 * so memory stays bounded regardless of media size.
 *
 * Declared `exported="false"` (only this app can target it) with
 * `grantUriPermissions="true"` so a share-sheet flow can hand a one-shot
 * read grant to another app via `Intent.FLAG_GRANT_READ_URI_PERMISSION`.
 * For sharing, prefer the module's `getShareableMediaUrl` — it snapshots to
 * a file, so the shared media outlives the backend process.
 */
class MediaContentProvider : ContentProvider() {
    companion object {
        const val AUTHORITY_SUFFIX = ".comapeo.media"

        /** Returns this provider's authority for the given app [Context]. */
        fun authorityFor(context: Context): String =
            context.packageName + AUTHORITY_SUFFIX

        private const val PIPE_COPY_BUFFER = 64 * 1024
        private const val MAX_STREAMS = 8
    }

    /**
     * One thread per concurrent media stream, bounded at [MAX_STREAMS]:
     * each request blocks reading the HTTP response and writing the pipe's
     * far end, so a coroutine dispatcher would just turn into
     * one-OS-thread-per-request anyway. The bound matters when the backend
     * is down — image pipelines can open dozens of streams while each one
     * sits in connect-retry backoff, and an unbounded pool would park a
     * thread (≈1 MB stack) per image. Excess requests queue; idle threads
     * are reaped after 60s (core timeout enabled), matching the bursty
     * access pattern of an image-heavy list view.
     */
    private val executor = ThreadPoolExecutor(
        MAX_STREAMS,
        MAX_STREAMS,
        60L,
        TimeUnit.SECONDS,
        LinkedBlockingQueue(),
    ) { r ->
        Thread(r, "comapeo-media-stream").apply { isDaemon = true }
    }.apply { allowCoreThreadTimeOut(true) }

    override fun onCreate(): Boolean = true

    override fun getType(uri: Uri): String {
        // Blob/icon names carry no extension; the authoritative type is the
        // server's Content-Type header, which consumers see when they open
        // the stream. A generic type here is expected and harmless for the
        // image pipelines that call this.
        return "application/octet-stream"
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
                // truncating the stream — Glide / Fresco treat a closed
                // pipe with no error as an "incomplete file", which is
                // harder to diagnose than an explicit error message.
                try {
                    writeSide.closeWithError(e.message ?: "media stream error")
                } catch (_: IOException) {
                    // Read side already closed — nothing to report to.
                }
            }
        }

        return readSide
    }

    /**
     * On success, closes [writeSide] normally (clean EOF). On ANY failure —
     * connect, non-2xx, or mid-copy — it throws WITHOUT closing
     * [writeSide], so the caller's `closeWithError` actually reaches the
     * reader. (Wrapping the pipe in `AutoCloseOutputStream(...).use {}`
     * would close it with an OK status on the exception path first, turning
     * `closeWithError` into a no-op and every error into a silent
     * truncated/empty stream.)
     */
    private fun streamHttpResponse(
        socketFile: File,
        pathAndQuery: String,
        writeSide: ParcelFileDescriptor,
    ) {
        MediaHttpClient.get(socketFile, pathAndQuery).use { response ->
            if (response.status !in 200..299) {
                throw FileNotFoundException(
                    "HTTP ${response.status} for $pathAndQuery",
                )
            }
            val out = ParcelFileDescriptor.AutoCloseOutputStream(writeSide)
            val copied = response.body.copyTo(out, PIPE_COPY_BUFFER)
            // HTTP/1.0 bodies are EOF-delimited, so a backend dying
            // mid-response looks like completion at the socket layer —
            // verify against Content-Length (Fastify always sends it)
            // rather than passing truncated media off as complete.
            val expected = response.headers["content-length"]?.toLongOrNull()
            if (expected != null && copied != expected) {
                throw IOException("Truncated body: $copied of $expected bytes")
            }
            out.close()
        }
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
