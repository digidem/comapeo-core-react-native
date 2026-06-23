package com.comapeo.core

import android.content.Context
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec

/**
 * Reads the 16-byte rootkey from the store the previous Android app used:
 * `expo-secure-store`. Used exactly once per device, on the first boot of a build
 * that owns [RootKeyStore]; after migration the native store takes precedence and
 * this decoder is never reached again (see
 * docs/root-key-storage-and-migration-plan.md §2).
 *
 * The previous app wrote the rootkey as a hex string (`uint8ArrayToHex` of 16
 * random bytes — a 32-char string). `expo-secure-store` then encrypted that
 * *string*. So decrypting yields the UTF-8 hex string, which this decoder
 * hex-decodes back to the 16 raw bytes. Getting that wrong is silent identity
 * loss, so [decode] length-checks the result and throws on any mismatch rather
 * than returning a wrong-but-plausible key.
 *
 * Parameters below are pinned from the shipped consuming app (comapeo-mobile) and
 * verified against `expo-secure-store@56.0.4` source:
 * - SharedPreferences file: `"SecureStore"`.
 * - Pref key: `"<keychainService>-<keyName>"`, falling back to the bare
 *   `"<keyName>"` (the format `expo-secure-store` used before keychain-aware keys).
 * - keychainService: the app set none, so the `expo-secure-store` default `"key_v1"`.
 * - keyName: `"__RootKey"` (the string passed to `getItemAsync`).
 * - Keystore alias for the AES (unauthenticated) scheme:
 *   `"AES/GCM/NoPadding:<keychainService>:keystoreUnauthenticated"` when the entry
 *   has `usesKeystoreSuffix=true`, else the bare `"AES/GCM/NoPadding:<keychainService>"`.
 *   Note the envelope's own `keystoreAlias` field holds only the keychainService
 *   string, not the full keystore alias — the full alias is reconstructed here.
 */
internal class LegacyRootKeyDecoder(private val context: Context) {

    companion object {
        const val SECURE_STORE_PREFS_NAME = "SecureStore"
        const val KEY_NAME = "__RootKey"
        const val DEFAULT_KEYCHAIN_SERVICE = "key_v1"

        // expo-secure-store envelope fields (AESEncryptor / SecureStoreModule).
        private const val SCHEME_PROPERTY = "scheme"
        private const val CIPHERTEXT_PROPERTY = "ct"
        private const val IV_PROPERTY = "iv"
        private const val TAG_LENGTH_PROPERTY = "tlen"
        private const val USES_KEYSTORE_SUFFIX_PROPERTY = "usesKeystoreSuffix"

        private const val SCHEME_AES = "aes"
        private const val SCHEME_HYBRID = "hybrid"

        private const val AES_CIPHER = "AES/GCM/NoPadding"
        private const val UNAUTHENTICATED_KEYSTORE_SUFFIX = "keystoreUnauthenticated"
    }

    /**
     * Returns the decoded 16-byte rootkey, or `null` if no legacy entry exists
     * (a true first install on this device). Throws [RootKeyException] when an
     * entry exists but cannot be safely decoded — caller must surface that as an
     * error, never regenerate.
     */
    @Throws(RootKeyException::class)
    fun decode(): ByteArray? {
        val raw = readRawEnvelope() ?: return null
        val envelope = parseEnvelope(raw)
        val hexString = decrypt(envelope)
        val key = hexDecode(hexString)
        if (key.size != RootKeyStore.ROOTKEY_BYTE_LENGTH) {
            throw RootKeyException(
                "Legacy rootkey decoded to wrong length: ${key.size} " +
                    "(expected ${RootKeyStore.ROOTKEY_BYTE_LENGTH})",
            )
        }
        return key
    }

    private fun readRawEnvelope(): String? {
        val prefs = context.getSharedPreferences(SECURE_STORE_PREFS_NAME, Context.MODE_PRIVATE)
        val keychainAwareKey = "$DEFAULT_KEYCHAIN_SERVICE-$KEY_NAME"
        return prefs.getString(keychainAwareKey, null)
            ?: prefs.getString(KEY_NAME, null)
    }

    private data class LegacyEnvelope(
        val iv: ByteArray,
        val ct: ByteArray,
        val tagLengthBits: Int,
        val usesKeystoreSuffix: Boolean,
    )

    private fun parseEnvelope(raw: String): LegacyEnvelope {
        val json = try {
            JSONObject(raw)
        } catch (e: Exception) {
            throw RootKeyException("Failed to parse legacy rootkey envelope JSON", e)
        }
        val scheme = json.optString(SCHEME_PROPERTY, "")
        if (scheme == SCHEME_HYBRID) {
            throw RootKeyException(
                "Legacy rootkey uses unsupported 'hybrid' scheme (pre-API-23 entry)",
            )
        }
        if (scheme != SCHEME_AES) {
            throw RootKeyException("Legacy rootkey has unknown encryption scheme: '$scheme'")
        }
        val ivStr = json.optString(IV_PROPERTY, "")
        val ctStr = json.optString(CIPHERTEXT_PROPERTY, "")
        val tagLength = json.optInt(TAG_LENGTH_PROPERTY, -1)
        if (ivStr.isEmpty() || ctStr.isEmpty() || tagLength <= 0) {
            throw RootKeyException("Legacy rootkey envelope missing required fields")
        }
        val usesKeystoreSuffix = json.optBoolean(USES_KEYSTORE_SUFFIX_PROPERTY, false)
        val (iv, ct) = try {
            Base64.decode(ivStr, Base64.DEFAULT) to Base64.decode(ctStr, Base64.DEFAULT)
        } catch (e: IllegalArgumentException) {
            throw RootKeyException("Failed to Base64-decode legacy rootkey envelope iv/ct", e)
        }
        return LegacyEnvelope(iv, ct, tagLength, usesKeystoreSuffix)
    }

    /** Decrypts the legacy envelope, returning the stored UTF-8 string (the hex rootkey). */
    private fun decrypt(envelope: LegacyEnvelope): String {
        val alias = keystoreAlias(envelope.usesKeystoreSuffix)
        val entry = try {
            val ks = KeyStore.getInstance(RootKeyStore.ANDROID_KEY_STORE).apply { load(null) }
            ks.getEntry(alias, null) as? KeyStore.SecretKeyEntry
        } catch (e: Exception) {
            throw RootKeyException("Failed to access legacy keystore alias '$alias'", e)
        } ?: throw RootKeyException(
            "Legacy keystore alias missing — keystore was wiped, rootkey unrecoverable",
        )
        val plaintext = try {
            Cipher.getInstance(AES_CIPHER).apply {
                init(
                    Cipher.DECRYPT_MODE,
                    entry.secretKey,
                    GCMParameterSpec(envelope.tagLengthBits, envelope.iv),
                )
            }.doFinal(envelope.ct)
        } catch (e: Exception) {
            throw RootKeyException("Legacy rootkey decrypt failed", e)
        }
        return String(plaintext, Charsets.UTF_8)
    }

    private fun keystoreAlias(usesKeystoreSuffix: Boolean): String {
        val base = "$AES_CIPHER:$DEFAULT_KEYCHAIN_SERVICE"
        return if (usesKeystoreSuffix) "$base:$UNAUTHENTICATED_KEYSTORE_SUFFIX" else base
    }

    private fun hexDecode(hex: String): ByteArray {
        if (hex.length % 2 != 0) {
            throw RootKeyException("Legacy rootkey hex string has odd length: ${hex.length}")
        }
        val out = ByteArray(hex.length / 2)
        for (i in out.indices) {
            val hi = Character.digit(hex[i * 2], 16)
            val lo = Character.digit(hex[i * 2 + 1], 16)
            if (hi < 0 || lo < 0) {
                throw RootKeyException("Legacy rootkey contains non-hex characters")
            }
            out[i] = ((hi shl 4) or lo).toByte()
        }
        return out
    }
}
