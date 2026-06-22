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

/** `generated=true` → first-install path. NodeJSService stamps this on `boot.rootkey-load`. */
@Suppress("ArrayInDataClass")
data class RootKeyResult(val key: ByteArray, val generated: Boolean)

/**
 * Persistent store for the 16-byte CoMapeo rootkey.
 *
 * The rootkey is the device's identity across every CoMapeo project — generated
 * once on first launch and never rotated. Regenerating produces a new identity,
 * which is identity loss.
 *
 * Steady state: a SharedPreferences read + AndroidKeyStore AES/GCM decrypt.
 * First launch additionally writes the envelope under a fresh wrapper key.
 *
 * On a decrypt failure (e.g. credential reset wiped the AndroidKeyStore alias
 * on some OEMs), throws — never silently regenerates. The consuming app must
 * surface unrecoverable rootkey loss to the user.
 *
 * Logging is restricted to state strings; rootkey, ciphertext, and wrapper key
 * are never logged.
 */
class RootKeyStore(private val context: Context) {

    companion object {
        const val ROOTKEY_BYTE_LENGTH = 16

        /**
         * Three independent versioning axes. They share `1` today but don't move
         * together — bump each only on a change to its own slot:
         * - [WRAPPER_KEY_ALIAS]: wrapper-key params (algorithm, size, auth flags) change
         *   in a way that invalidates existing ciphertext.
         * - [PREFS_KEY]: v1 and v2 envelopes need to coexist on the same install (e.g.
         *   a transitional re-wrap migration; see docs/root-key-storage-and-migration-plan.md §2.1).
         * - [ENVELOPE_VERSION]: the envelope JSON shape changes (fields added/removed/renamed).
         */
        const val WRAPPER_KEY_ALIAS = "comapeo-rootkey-wrapper-v1"
        const val PREFS_NAME = "comapeo-core"
        const val PREFS_KEY = "rootkey.v1"
        const val ENVELOPE_VERSION = 1

        const val ANDROID_KEY_STORE = "AndroidKeyStore"
        const val GCM_TAG_LENGTH_BITS = 128
        const val GCM_IV_LENGTH_BYTES = 12
    }

    /**
     * Returns the 16-byte rootkey + whether this call generated it. Generates and
     * persists on first launch. Synchronous; safe to call from the FGS startup path.
     * Throws on any failure that would risk silently fabricating a new identity.
     */
    @Throws(RootKeyException::class)
    fun loadOrInitialize(): RootKeyResult {
        nativeHitOrRecover()?.let {
            return RootKeyResult(it, generated = false)
        }

        migrateFromLegacy()?.let {
            log("RootKeyStore: migrated from expo-secure-store")
            return RootKeyResult(it, generated = false)
        }

        log("RootKeyStore: generated for first install")
        return RootKeyResult(generateAndPersist(), generated = true)
    }

    /**
     * Native-store read with the §7 recovery hatch: if a native blob is present
     * but fails to decrypt, fall back to the legacy store before giving up rather
     * than surfacing the error immediately. A present-but-corrupt native blob with
     * a recoverable legacy entry is itself recoverable; we only surface the native
     * decrypt failure when there is no legacy entry to fall back to.
     */
    private fun nativeHitOrRecover(): ByteArray? {
        val native = try {
            loadExisting()
        } catch (e: RootKeyException) {
            log("RootKeyStore: native decrypt failed, attempting legacy fallback")
            val recovered = try {
                migrateFromLegacy()
            } catch (_: RootKeyException) {
                // Surface the original native failure; the legacy attempt is a best-
                // effort recovery, not the primary path here.
                throw e
            }
            if (recovered != null) {
                log("RootKeyStore: recovered via legacy fallback")
                return recovered
            }
            throw e
        }
        if (native != null) {
            log("RootKeyStore: native hit")
        }
        return native
    }

    /**
     * One-shot, one-way migration: decode the rootkey from the previous app's
     * `expo-secure-store`, re-wrap under our wrapper key, and persist. Returns the
     * 16 bytes, or `null` if there is no legacy entry (true first install). Never
     * touches the legacy entry — it stays in place as the only on-device recovery
     * hatch (see docs/root-key-storage-and-migration-plan.md §2.1).
     */
    private fun migrateFromLegacy(): ByteArray? {
        val legacyKey = LegacyRootKeyDecoder(context).decode() ?: return null
        return try {
            persistAndVerify(legacyKey)
        } finally {
            legacyKey.fill(0)
        }
    }

    private fun loadExisting(): ByteArray? {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val raw = prefs.getString(PREFS_KEY, null) ?: return null
        val envelope = parseEnvelope(raw)
        val wrapperKey = loadWrapperKey()
            ?: throw RootKeyException("Wrapper key alias missing — keystore was wiped")

        // Validate before passing to GCMParameterSpec / Cipher.init — they throw
        // bare provider exceptions on malformed input, breaking the all-failures-
        // through-RootKeyException contract. Empty ct is envelope corruption, not
        // a decrypt failure, so catch it here too.
        if (envelope.iv.size != GCM_IV_LENGTH_BYTES) {
            throw RootKeyException(
                "Envelope IV has wrong length: ${envelope.iv.size} (expected $GCM_IV_LENGTH_BYTES)",
            )
        }
        if (envelope.ct.isEmpty()) {
            throw RootKeyException("Envelope ciphertext is empty")
        }

        val cipher = try {
            Cipher.getInstance("AES/GCM/NoPadding").apply {
                init(
                    Cipher.DECRYPT_MODE,
                    wrapperKey,
                    GCMParameterSpec(GCM_TAG_LENGTH_BITS, envelope.iv),
                )
            }
        } catch (e: Exception) {
            throw RootKeyException("rootkey: decrypt setup failed", e)
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
        return try {
            persistAndVerify(plaintext)
        } finally {
            plaintext.fill(0)
        }
    }

    /**
     * Wraps [plaintext] under our wrapper key, writes the envelope with a durable
     * `commit()`, then reads it back and byte-compares before returning. Shared by
     * the generate and legacy-migrate paths. Does not zero [plaintext] — the caller
     * owns its lifetime.
     */
    private fun persistAndVerify(plaintext: ByteArray): ByteArray {
        if (plaintext.size != ROOTKEY_BYTE_LENGTH) {
            throw RootKeyException(
                "Refusing to persist rootkey of wrong length: ${plaintext.size} " +
                    "(expected $ROOTKEY_BYTE_LENGTH)",
            )
        }
        val wrapperKey = createOrLoadWrapperKey()
        // With `setRandomizedEncryptionRequired(true)`, hardware-backed AndroidKeyStore
        // refuses a caller-supplied IV at encrypt time (InvalidAlgorithmParameterException
        // on API 30+). Let the keystore generate the IV; read `cipher.iv` after init().
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(Cipher.ENCRYPT_MODE, wrapperKey)
        }
        val ct = cipher.doFinal(plaintext)
        val iv = cipher.iv
        if (iv == null || iv.size != GCM_IV_LENGTH_BYTES) {
            // Defensive: loadExisting enforces 12-byte IVs, so a different-length IV
            // here would silently produce an unreadable envelope on next read.
            throw RootKeyException(
                "Keystore returned unexpected IV length: ${iv?.size} " +
                    "(expected $GCM_IV_LENGTH_BYTES)",
            )
        }
        val envelopeJson = JSONObject().apply {
            put("v", ENVELOPE_VERSION)
            put("alias", WRAPPER_KEY_ALIAS)
            put("iv", Base64.encodeToString(iv, Base64.NO_WRAP))
            put("ct", Base64.encodeToString(ct, Base64.NO_WRAP))
        }.toString()

        // commit() over apply() — apply()'s async semantics could leave us with the
        // keystore alias but no envelope if the process is killed mid-write. Raw editor
        // so we can observe commit()'s Boolean and surface persistence failures.
        @Suppress("ApplySharedPref")
        val written = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(PREFS_KEY, envelopeJson)
            .commit()
        if (!written) throw RootKeyException("Failed to persist rootkey envelope")

        // Read-back + byte-compare: microseconds of cost against identity loss from
        // writing a corrupt envelope.
        val verified = loadExisting()
            ?: throw RootKeyException("Wrote rootkey envelope but read-back returned null")
        if (!verified.contentEquals(plaintext)) {
            throw RootKeyException("Rootkey verification mismatch after write")
        }
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
            // Threat model is "device at rest is stolen", not in-process app attack.
            .setUserAuthenticationRequired(false)

        // Not using setUnlockedDeviceRequired(true): generation fails on no-lock
        // devices and disabling the lock later permanently invalidates the key —
        // both are identity loss. See PR #57.

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
                // Opportunistic — non-StrongBox devices still get a hardware-backed key.
                builder.setIsStrongBoxBacked(false)
            }
        }
        generator.init(builder.build())
        return generator.generateKey()
    }

    @Suppress("ArrayInDataClass")
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
        // Pinned to the only alias v1 can describe — a v2 wrapper key would gate via
        // the version check above. Catches a tampered envelope or one pointing at a
        // key the keystore can't load.
        if (alias != WRAPPER_KEY_ALIAS) {
            throw RootKeyException(
                "Envelope alias mismatch: $alias (expected $WRAPPER_KEY_ALIAS)",
            )
        }
        // Funnel Base64 failures through RootKeyException so the all-failures-through-
        // RootKeyException contract holds; callers depend on it for identity-load UX.
        val (iv, ct) = try {
            Base64.decode(ivStr, Base64.NO_WRAP) to Base64.decode(ctStr, Base64.NO_WRAP)
        } catch (e: IllegalArgumentException) {
            throw RootKeyException("Failed to Base64-decode rootkey envelope iv/ct fields", e)
        }
        return Envelope(v, alias, iv, ct)
    }
}

class RootKeyException(message: String, cause: Throwable? = null) :
    RuntimeException(message, cause)
