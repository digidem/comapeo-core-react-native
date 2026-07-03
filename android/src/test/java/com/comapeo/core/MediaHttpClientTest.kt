package com.comapeo.core

import com.comapeo.core.media.MediaHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * JVM tests for the pure logic in [MediaHttpClient]: the Content-Type →
 * file-extension mapping used to name share-sheet snapshots (blob names
 * carry no extension, so receiving apps depend on this one). Must stay
 * byte-identical to the iOS mapping in `MediaFetcher.swift`.
 */
class MediaHttpClientTest {

    @Test
    fun mapsCommonMediaTypes() {
        assertEquals("jpg", MediaHttpClient.extensionForMimeType("image/jpeg"))
        assertEquals("png", MediaHttpClient.extensionForMimeType("image/png"))
        assertEquals("gif", MediaHttpClient.extensionForMimeType("image/gif"))
        assertEquals("webp", MediaHttpClient.extensionForMimeType("image/webp"))
        assertEquals("svg", MediaHttpClient.extensionForMimeType("image/svg+xml"))
        assertEquals("heic", MediaHttpClient.extensionForMimeType("image/heic"))
        assertEquals("mp4", MediaHttpClient.extensionForMimeType("video/mp4"))
        assertEquals("mov", MediaHttpClient.extensionForMimeType("video/quicktime"))
        assertEquals("mp3", MediaHttpClient.extensionForMimeType("audio/mpeg"))
        assertEquals("m4a", MediaHttpClient.extensionForMimeType("audio/mp4"))
        assertEquals("pdf", MediaHttpClient.extensionForMimeType("application/pdf"))
    }

    @Test
    fun ignoresParametersAndCase() {
        assertEquals(
            "png",
            MediaHttpClient.extensionForMimeType("image/PNG; charset=binary"),
        )
        assertEquals("jpg", MediaHttpClient.extensionForMimeType(" image/jpeg "))
    }

    @Test
    fun unknownTypesReturnNull() {
        assertNull(MediaHttpClient.extensionForMimeType(null))
        assertNull(MediaHttpClient.extensionForMimeType(""))
        assertNull(MediaHttpClient.extensionForMimeType("application/x-unknown"))
    }
}
