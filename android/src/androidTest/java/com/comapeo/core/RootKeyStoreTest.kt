package com.comapeo.core

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertThrows
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.security.KeyStore

/**
 * Instrumented tests for [RootKeyStore]. Run on a real device or emulator
 * because they exercise AndroidKeyStore (a TEE/StrongBox-backed service
 * that has no JVM-only equivalent).
 *
 * State is purged in [setUp] so the suite is order-independent.
 */
@RunWith(AndroidJUnit4::class)
class RootKeyStoreTest {

    private lateinit var context: Context

    @Before
    fun setUp() {
        context = InstrumentationRegistry.getInstrumentation().targetContext
        purgePersistentState()
    }

    @After
    fun tearDown() {
        purgePersistentState()
    }

    /**
     * Removes both halves of the persisted state so each test starts
     * from a known blank slate. Failure to load either side is fatal —
     * better to fail loudly than silently leak alias/blob into the next
     * test (or worse, the user's keystore on a personal device).
     */
    private fun purgePersistentState() {
        val ks = KeyStore.getInstance(RootKeyStore.ANDROID_KEY_STORE).apply { load(null) }
        if (ks.containsAlias(RootKeyStore.WRAPPER_KEY_ALIAS)) {
            ks.deleteEntry(RootKeyStore.WRAPPER_KEY_ALIAS)
        }
        context.getSharedPreferences(RootKeyStore.PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .remove(RootKeyStore.PREFS_KEY)
            .commit()
    }

    @Test
    fun firstCallGeneratesAndSecondCallReturnsSameBytes() {
        val store = RootKeyStore(context)

        val first = store.loadOrInitialize()
        assertEquals(
            "first call must report generated=true on a purged store",
            true,
            first.generated,
        )
        assertEquals(
            "rootkey must be 16 bytes",
            RootKeyStore.ROOTKEY_BYTE_LENGTH,
            first.key.size,
        )

        // A fresh instance proves the state lives in persistent storage,
        // not just in this object's memory. The second-call return must
        // byte-equal the first — anything else is identity loss.
        val second = RootKeyStore(context).loadOrInitialize()
        assertEquals(
            "second call must report generated=false (loaded from prefs)",
            false,
            second.generated,
        )
        assertArrayEquals(
            "second call must return identical bytes (else identity rotation)",
            first.key,
            second.key,
        )
    }

    @Test
    fun corruptedEnvelopeThrows() {
        // Seed a valid envelope so we know subsequent reads see real data.
        RootKeyStore(context).loadOrInitialize()

        // Truncate the persisted JSON so JSONObject parse fails. The
        // contract is "throw, do not silently regenerate" — anything
        // that swallows this would mask identity loss.
        context.getSharedPreferences(RootKeyStore.PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(RootKeyStore.PREFS_KEY, "not valid json {")
            .commit()

        val ex = assertThrows(RootKeyException::class.java) {
            RootKeyStore(context).loadOrInitialize()
        }
        assertNotNull(ex.message)
    }
}
