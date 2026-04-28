package com.comapeo.core

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Persistent store for the 16-byte CoMapeo rootkey on Android.
 *
 * The rootkey is the device's identity in every CoMapeo project it
 * participates in. It is generated once on first launch and never rotated —
 * regenerating produces a new device identity, which is identity loss.
 *
 * Steady state: a single SharedPreferences read followed by an
 * AndroidKeyStore-backed AES/GCM decrypt. First launch additionally writes
 * the encrypted blob with a fresh wrapper key.
 *
 * Failure modes:
 * - Native blob present but decrypt fails (e.g. the user did a credential
 *   reset that wiped the AndroidKeyStore alias on some OEMs): throws.
 *   We do **not** silently regenerate — the rootkey is unrecoverable and
 *   the consuming app must surface that to the user.
 * - First launch and write back-verification fails: throws.
 *
 * Logging is restricted to state-transition strings; the rootkey, ciphertext,
 * and wrapper key are never logged.
 */
class RootKeyStore(private val context: Context) {

    companion object {
        const val ROOTKEY_BYTE_LENGTH = 16

        const val WRAPPER_KEY_ALIAS = "comapeo-rootkey-wrapper-v1"
        const val PREFS_NAME = "comapeo-core"
        const val PREFS_KEY = "rootkey.v1"
        const val ENVELOPE_VERSION = 1
        const val ANDROID_KEY_STORE = "AndroidKeyStore"
        const val GCM_TAG_LENGTH_BITS = 128
        const val GCM_IV_LENGTH_BYTES = 12
    }

    /**
     * Returns the 16-byte rootkey, generating and persisting it on first
     * launch. Synchronous; safe to call from the FGS startup path. Throws
     * on any failure path that would otherwise risk silently fabricating
     * a new identity.
     */
    @Throws(RootKeyException::class)
    fun loadOrInitialize(): ByteArray {
        loadExisting()?.let {
            log("RootKeyStore: native hit")
            return it
        }
        log("RootKeyStore: generated for first install")
        return generateAndPersist()
    }

    private fun loadExisting(): ByteArray? {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val raw = prefs.getString(PREFS_KEY, null) ?: return null
        val envelope = parseEnvelope(raw)
        val wrapperKey = loadWrapperKey()
            ?: throw RootKeyException("Wrapper key alias missing — keystore was wiped")

        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(
                Cipher.DECRYPT_MODE,
                wrapperKey,
                GCMParameterSpec(GCM_TAG_LENGTH_BITS, envelope.iv),
            )
        }
        val plaintext = try {
            cipher.doFinal(envelope.ct)
        } catch (e: Exception) {
            throw RootKeyException("rootkey: decrypt failed", e)
        }
        if (plaintext.size != ROOTKEY_BYTE_LENGTH) {
            throw RootKeyException(
                "Decoded rootkey has wrong length: ${plaintext.size} (expected $ROOTKEY_BYTE_LENGTH)",
            )
        }
        return plaintext
    }

    private fun generateAndPersist(): ByteArray {
        val plaintext = ByteArray(ROOTKEY_BYTE_LENGTH).also { SecureRandom().nextBytes(it) }
        val wrapperKey = createOrLoadWrapperKey()
        val iv = ByteArray(GCM_IV_LENGTH_BYTES).also { SecureRandom().nextBytes(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(
                Cipher.ENCRYPT_MODE,
                wrapperKey,
                GCMParameterSpec(GCM_TAG_LENGTH_BITS, iv),
            )
        }
        val ct = cipher.doFinal(plaintext)
        val envelopeJson = JSONObject().apply {
            put("v", ENVELOPE_VERSION)
            put("alias", WRAPPER_KEY_ALIAS)
            put("iv", Base64.encodeToString(iv, Base64.NO_WRAP))
            put("ct", Base64.encodeToString(ct, Base64.NO_WRAP))
        }.toString()

        // commit() over apply() — synchronous durable write before the FGS
        // proceeds. apply()'s async semantics are unacceptable: if the
        // process is killed between apply() and the write hitting disk,
        // we'd be left with the keystore alias but no envelope. Use the
        // raw editor (rather than the `edit { }` extension) so we can
        // observe `commit()`'s Boolean return and surface persistence
        // failures explicitly.
        @Suppress("ApplySharedPref")
        val written = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(PREFS_KEY, envelopeJson)
            .commit()
        if (!written) throw RootKeyException("Failed to persist rootkey envelope")

        // Cheap paranoia: read it back and byte-compare before declaring
        // success. The cost is microseconds; the cost of writing a corrupt
        // envelope is identity loss.
        val verified = loadExisting()
            ?: throw RootKeyException("Wrote rootkey envelope but read-back returned null")
        if (!verified.contentEquals(plaintext)) {
            throw RootKeyException("Rootkey verification mismatch after write")
        }
        // Zero the local plaintext copy. The verified array is the one we
        // return; the caller is responsible for zeroing it after use.
        plaintext.fill(0)
        return verified
    }

    private fun loadWrapperKey(): SecretKey? {
        val ks = KeyStore.getInstance(ANDROID_KEY_STORE).apply { load(null) }
        if (!ks.containsAlias(WRAPPER_KEY_ALIAS)) return null
        val entry = ks.getEntry(WRAPPER_KEY_ALIAS, null) as? KeyStore.SecretKeyEntry
            ?: return null
        return entry.secretKey
    }

    private fun createOrLoadWrapperKey(): SecretKey {
        loadWrapperKey()?.let { return it }

        val builder = KeyGenParameterSpec.Builder(
            WRAPPER_KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setKeySize(256)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            // Explicit: no biometrics, no user-presence flags. The threat
            // model is "device at rest is stolen", not "running app is
            // attacked by another app on the same device".
            .setUserAuthenticationRequired(false)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            builder.setUnlockedDeviceRequired(true)
        }

        val generator = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES,
            ANDROID_KEY_STORE,
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            try {
                builder.setIsStrongBoxBacked(true)
                generator.init(builder.build())
                return generator.generateKey()
            } catch (_: StrongBoxUnavailableException) {
                // Fall through to the non-StrongBox path. StrongBox is
                // opportunistic — devices without it (most non-Pixel
                // hardware) still get a hardware-backed AndroidKeyStore key.
                builder.setIsStrongBoxBacked(false)
            }
        }
        generator.init(builder.build())
        return generator.generateKey()
    }

    private data class Envelope(val v: Int, val alias: String, val iv: ByteArray, val ct: ByteArray)

    private fun parseEnvelope(raw: String): Envelope {
        val json = try {
            JSONObject(raw)
        } catch (e: Exception) {
            throw RootKeyException("Failed to parse rootkey envelope JSON", e)
        }
        val v = json.optInt("v", -1)
        if (v != ENVELOPE_VERSION) {
            throw RootKeyException("Unsupported rootkey envelope version: $v")
        }
        val alias = json.optString("alias", "")
        val ivStr = json.optString("iv", "")
        val ctStr = json.optString("ct", "")
        if (alias.isEmpty() || ivStr.isEmpty() || ctStr.isEmpty()) {
            throw RootKeyException("Rootkey envelope missing required fields")
        }
        val iv = Base64.decode(ivStr, Base64.NO_WRAP)
        val ct = Base64.decode(ctStr, Base64.NO_WRAP)
        return Envelope(v, alias, iv, ct)
    }
}

class RootKeyException(message: String, cause: Throwable? = null) :
    RuntimeException(message, cause)
