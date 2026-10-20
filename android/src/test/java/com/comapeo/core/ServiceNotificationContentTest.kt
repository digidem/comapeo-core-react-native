package com.comapeo.core

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * JVM-only tests for the host-wording persistence in [ServiceNotificationContent].
 * What the notification shows for a given content is covered on a device by
 * `ServiceNotificationTest` and the integration app's `ServiceLifecycleTest`.
 */
class ServiceNotificationContentTest {

    private class FakeStore : ComapeoPrefs.Store {
        private val strings = mutableMapOf<String, String>()
        override fun getBoolean(key: String): Boolean? = null
        override fun putBoolean(key: String, value: Boolean) = Unit
        override fun getLong(key: String): Long? = null
        override fun putLong(key: String, value: Long) = Unit
        override fun getString(key: String): String? = strings[key]
        override fun putString(key: String, value: String) { strings[key] = value }
        override fun remove(key: String) { strings.remove(key) }
    }

    @Test
    fun blankFieldsFallBackToDefaults() {
        assertEquals(
            ServiceNotificationContent(title = null, body = "B"),
            ServiceNotificationContent.of(title = "  ", body = "B"),
        )
    }

    @Test
    fun lastWriteWinsIncludingReset() {
        val store = FakeStore()
        ServiceNotificationContent.of("Título", "Cuerpo").write(store)
        assertEquals(ServiceNotificationContent("Título", "Cuerpo"), ServiceNotificationContent.read(store))

        ServiceNotificationContent.of("Only title", null).write(store)
        assertEquals(ServiceNotificationContent("Only title", null), ServiceNotificationContent.read(store))

        ServiceNotificationContent.of(null, null).write(store)
        assertEquals(ServiceNotificationContent(), ServiceNotificationContent.read(store))
    }
}
