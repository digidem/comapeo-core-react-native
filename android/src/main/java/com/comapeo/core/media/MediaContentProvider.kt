package com.comapeo.core.media

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
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
 * `grantUriPermissions="true"`, and these URIs are the **share-sheet
 * currency** too: `getShareableMediaUrl` hands out the same `content://`
 * URI, and a share Intent carrying `FLAG_GRANT_READ_URI_PERMISSION` (+
 * `setClipData`) gives the chosen app a one-shot read that streams
 * straight off the socket — zero copy, no cache file for low-storage
 * devices to evict. [getType] and [query] answer receivers' MIME/name
 * lookups from the served HTTP headers. The socket is served by the
 * `:ComapeoCore` foreground service, which outlives app switches; a
 * receiver that defers its read until after the backend stops (or that
 * requires a *seekable* descriptor — some video players) is the residual
 * trade-off versus a file snapshot.
 */
class MediaContentProvider : ContentProvider() {
    companion object {
        const val AUTHORITY_SUFFIX = ".comapeo.media"

        /** Returns this provider's authority for the given app [Context]. */
        fun authorityFor(context: Context): String =
            context.packageName + AUTHORITY_SUFFIX

        private const val PIPE_COPY_BUFFER = 64 * 1024
        private const val MAX_STREAMS = 8

        /**
         * Connect budget for resolver-metadata calls ([getType]/[query]):
         * these run on binder threads answering *other apps'* requests
         * (the share sheet, a receiving app), so they must answer in
         * ~100s of ms, not sit through the boot-covering backoff the
         * streaming path uses. On failure they degrade (generic MIME, no
         * size) instead of erroring.
         */
        private const val METADATA_CONNECT_RETRIES = 2

        /**
         * pathAndQuery → served Content-Type, filled from response headers
         * on every open/HEAD so share-sheet metadata queries usually never
         * touch the socket. Small LRU: entries are ~100 bytes and the
         * working set is whatever media is on screen or being shared.
         */
        private val contentTypeCache =
            object : LinkedHashMap<String, String>(64, 0.75f, true) {
                override fun removeEldestEntry(
                    eldest: MutableMap.MutableEntry<String, String>,
                ): Boolean = size > 256
            }

        internal fun cacheContentType(pathAndQuery: String, contentType: String?) {
            if (contentType == null) return
            synchronized(contentTypeCache) {
                contentTypeCache[pathAndQuery] = contentType
            }
        }

        private fun cachedContentType(pathAndQuery: String): String? =
            synchronized(contentTypeCache) { contentTypeCache[pathAndQuery] }
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

    /**
     * The served Content-Type. Share-sheet receivers resolve MIME through
     * this (they never see the HTTP header), and use it to pick previews,
     * handlers, and whether to accept the item at all. Answered from the
     * header cache when possible, else a bounded HEAD over the UDS;
     * degrades to a generic type when the backend is unreachable.
     */
    override fun getType(uri: Uri): String =
        contentTypeFor(pathAndQuery(uri)) ?: "application/octet-stream"

    private fun pathAndQuery(uri: Uri): String = buildString {
        append(uri.encodedPath ?: "/")
        uri.encodedQuery?.let { append("?").append(it) }
    }

    private fun contentTypeFor(pathAndQuery: String): String? {
        cachedContentType(pathAndQuery)?.let { return it }
        val ctx = context ?: return null
        val socketFile = File(ctx.filesDir, ComapeoCoreService.MEDIA_SOCKET_FILENAME)
        return try {
            MediaHttpClient.head(
                socketFile,
                pathAndQuery,
                retries = METADATA_CONNECT_RETRIES,
            ).use { response ->
                if (response.status !in 200..299) return null
                response.headers["content-type"]?.also {
                    cacheContentType(pathAndQuery, it)
                }
            }
        } catch (e: IOException) {
            null
        }
    }

    @Throws(FileNotFoundException::class)
    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        if (mode != "r") {
            throw FileNotFoundException("Only mode 'r' is supported (got '$mode')")
        }

        val ctx = context
            ?: throw FileNotFoundException("Provider has no context")
        val socketFile = File(ctx.filesDir, ComapeoCoreService.MEDIA_SOCKET_FILENAME)

        val pathAndQuery = pathAndQuery(uri)

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
            // Free metadata: later getType/query calls for this media
            // answer from cache instead of a HEAD round trip.
            cacheContentType(pathAndQuery, response.headers["content-type"])
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

    /**
     * [OpenableColumns] support for share-sheet receivers: Gmail/WhatsApp
     * -class apps query DISPLAY_NAME (and SIZE) to name the attachment and
     * render a preview row. The display name is the blob's path segment
     * plus an extension derived from the served Content-Type (blob names
     * carry none, and receivers key handlers off the extension). SIZE is
     * null: the backend streams without a Content-Length header (see the
     * backend media-serving test) — receivers treat unknown size as
     * "unsized stream", which is exactly what this is.
     */
    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): Cursor {
        val columns = projection
            ?: arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
        val pathAndQuery = pathAndQuery(uri)
        val cursor = MatrixCursor(columns, 1)
        cursor.addRow(
            columns.map { column ->
                when (column) {
                    OpenableColumns.DISPLAY_NAME -> displayNameFor(pathAndQuery)
                    else -> null
                }
            },
        )
        return cursor
    }

    private fun displayNameFor(pathAndQuery: String): String {
        val base = pathAndQuery.substringBefore('?')
            .substringAfterLast('/').ifEmpty { "media" }
        val ext = MediaHttpClient.extensionForMimeType(contentTypeFor(pathAndQuery))
        return if (ext != null) "$base.$ext" else base
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, s: String?, sa: Array<out String>?): Int = 0
    override fun update(
        uri: Uri,
        values: ContentValues?,
        selection: String?,
        selectionArgs: Array<out String>?,
    ): Int = 0
}
