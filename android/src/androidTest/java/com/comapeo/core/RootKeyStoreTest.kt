package com.comapeo.core

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.spec.GCMParameterSpec

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
        if (ks.containsAlias(LEGACY_KEYSTORE_ALIAS)) {
            ks.deleteEntry(LEGACY_KEYSTORE_ALIAS)
        }
        context.getSharedPreferences(RootKeyStore.PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .remove(RootKeyStore.PREFS_KEY)
            .commit()
        context.getSharedPreferences(
            LegacyRootKeyDecoder.SECURE_STORE_PREFS_NAME,
            Context.MODE_PRIVATE,
        ).edit().clear().commit()
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

    @Test
    fun legacyEntryMigratesToNativeStore() {
        seedLegacyEntry(KNOWN_HEX, keychainAware = true)

        val result = RootKeyStore(context).loadOrInitialize()
        assertFalse(
            "migration must not report generated=true (else identity loss)",
            result.generated,
        )
        assertArrayEquals(
            "migrated key must hex-decode the legacy value byte-for-byte",
            KNOWN_BYTES,
            result.key,
        )

        // The native blob must now exist so subsequent boots take the steady-state
        // path and never re-touch SecureStore.
        val nativeBlob = context
            .getSharedPreferences(RootKeyStore.PREFS_NAME, Context.MODE_PRIVATE)
            .getString(RootKeyStore.PREFS_KEY, null)
        assertNotNull("native blob must be written after migration", nativeBlob)
    }

    @Test
    fun legacyEntryUnderBareKeyMigrates() {
        seedLegacyEntry(KNOWN_HEX, keychainAware = false)

        val result = RootKeyStore(context).loadOrInitialize()
        assertArrayEquals(KNOWN_BYTES, result.key)
    }

    @Test
    fun afterMigrationSecondCallDoesNotTouchSecureStore() {
        seedLegacyEntry(KNOWN_HEX, keychainAware = true)
        val first = RootKeyStore(context).loadOrInitialize()

        // Wipe SecureStore: a steady-state boot must not depend on it.
        context.getSharedPreferences(
            LegacyRootKeyDecoder.SECURE_STORE_PREFS_NAME,
            Context.MODE_PRIVATE,
        ).edit().clear().commit()

        val second = RootKeyStore(context).loadOrInitialize()
        assertFalse(second.generated)
        assertArrayEquals(first.key, second.key)
    }

    @Test
    fun bothStoresEmptyGeneratesFirstInstall() {
        val result = RootKeyStore(context).loadOrInitialize()
        assertTrue("empty native + empty legacy must generate", result.generated)
        assertEquals(RootKeyStore.ROOTKEY_BYTE_LENGTH, result.key.size)

        // A legacy decode on a truly-empty SecureStore must be a clean miss, not an error.
        assertNull(LegacyRootKeyDecoder(context).decode())
    }

    @Test
    fun tamperedLegacyCiphertextThrowsNeverRegenerates() {
        seedLegacyEntry(KNOWN_HEX, keychainAware = true, tamperCiphertext = true)

        val ex = assertThrows(RootKeyException::class.java) {
            RootKeyStore(context).loadOrInitialize()
        }
        assertNotNull(ex.message)

        // Must NOT have silently generated and persisted a fresh identity.
        val nativeBlob = context
            .getSharedPreferences(RootKeyStore.PREFS_NAME, Context.MODE_PRIVATE)
            .getString(RootKeyStore.PREFS_KEY, null)
        assertNull("tampered legacy must not produce a native blob", nativeBlob)
    }

    @Test
    fun hybridSchemeThrows() {
        val prefs = context.getSharedPreferences(
            LegacyRootKeyDecoder.SECURE_STORE_PREFS_NAME,
            Context.MODE_PRIVATE,
        )
        val envelope = JSONObject()
            .put("scheme", "hybrid")
            .put("ct", "AA")
            .put("iv", "AA")
            .put("tlen", 128)
            .toString()
        prefs.edit().putString(
            "${LegacyRootKeyDecoder.DEFAULT_KEYCHAIN_SERVICE}-${LegacyRootKeyDecoder.KEY_NAME}",
            envelope,
        ).commit()

        val ex = assertThrows(RootKeyException::class.java) {
            RootKeyStore(context).loadOrInitialize()
        }
        assertTrue(ex.message!!.contains("hybrid"))
    }

    @Test
    fun nativeCorruptWithValidLegacyRecoversViaFallback() {
        seedLegacyEntry(KNOWN_HEX, keychainAware = true)
        // Garbage native blob alongside a valid legacy entry.
        context.getSharedPreferences(RootKeyStore.PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(RootKeyStore.PREFS_KEY, "not valid json {")
            .commit()

        val result = RootKeyStore(context).loadOrInitialize()
        assertArrayEquals(
            "native-corrupt + valid legacy must recover the legacy bytes",
            KNOWN_BYTES,
            result.key,
        )
    }

    @Test
    fun legacyDecodeRejectsWrongLengthVector() {
        // 15-byte hex (30 chars) — a decode that succeeds here would be silent
        // identity loss, so it must throw, not return a short key.
        seedLegacyEntry("00".repeat(15), keychainAware = true)

        assertThrows(RootKeyException::class.java) {
            LegacyRootKeyDecoder(context).decode()
        }
    }

    @Test
    fun encodingRoundTripFromKnownHexVector() {
        seedLegacyEntry(KNOWN_HEX, keychainAware = true)
        val decoded = LegacyRootKeyDecoder(context).decode()
        assertArrayEquals(
            "hex string must decode to the exact 16 bytes",
            KNOWN_BYTES,
            decoded,
        )
    }

    /**
     * Writes a handcrafted `expo-secure-store` AES entry: generates the legacy
     * AndroidKeyStore alias the way `expo-secure-store@56` does, encrypts [hex] as a
     * UTF-8 string, and stores the JSON envelope under the keychain-aware (or bare)
     * pref key. Mirrors AESEncryptor / SecureStoreModule.
     */
    private fun seedLegacyEntry(
        hex: String,
        keychainAware: Boolean,
        tamperCiphertext: Boolean = false,
    ) {
        val keyGen = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES,
            RootKeyStore.ANDROID_KEY_STORE,
        )
        keyGen.init(
            KeyGenParameterSpec.Builder(
                LEGACY_KEYSTORE_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setKeySize(256)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setUserAuthenticationRequired(false)
                .build(),
        )
        val secretKey = keyGen.generateKey()

        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secretKey)
        val tagLen = cipher.parameters
            .getParameterSpec(GCMParameterSpec::class.java).tLen
        val iv = cipher.iv
        val ctBytes = cipher.doFinal(hex.toByteArray(Charsets.UTF_8))
        if (tamperCiphertext) ctBytes[0] = (ctBytes[0].toInt() xor 0xFF).toByte()

        val envelope = JSONObject()
            .put("scheme", "aes")
            .put("ct", Base64.encodeToString(ctBytes, Base64.NO_WRAP))
            .put("iv", Base64.encodeToString(iv, Base64.NO_WRAP))
            .put("tlen", tagLen)
            .put("usesKeystoreSuffix", true)
            .put("keystoreAlias", LegacyRootKeyDecoder.DEFAULT_KEYCHAIN_SERVICE)
            .put("requireAuthentication", false)
            .toString()

        val prefKey = if (keychainAware) {
            "${LegacyRootKeyDecoder.DEFAULT_KEYCHAIN_SERVICE}-${LegacyRootKeyDecoder.KEY_NAME}"
        } else {
            LegacyRootKeyDecoder.KEY_NAME
        }
        context.getSharedPreferences(
            LegacyRootKeyDecoder.SECURE_STORE_PREFS_NAME,
            Context.MODE_PRIVATE,
        ).edit().putString(prefKey, envelope).commit()
    }

    companion object {
        // expo-secure-store AES alias for the default keychainService, unauthenticated.
        private const val LEGACY_KEYSTORE_ALIAS =
            "AES/GCM/NoPadding:key_v1:keystoreUnauthenticated"

        // Known-good test vector: a 16-byte rootkey and its uint8ArrayToHex string,
        // matching how the previous app stored it (32 lowercase hex chars).
        private val KNOWN_BYTES = byteArrayOf(
            0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77.toByte(),
            0x88.toByte(), 0x99.toByte(), 0xAA.toByte(), 0xBB.toByte(),
            0xCC.toByte(), 0xDD.toByte(), 0xEE.toByte(), 0xFF.toByte(),
        )
        private const val KNOWN_HEX = "00112233445566778899aabbccddeeff"
    }
}
