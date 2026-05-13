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
 * Result of [RootKeyStore.loadOrInitialize]. `generated = true` means this
 * call performed first-install key generation (AndroidKeyStore wrapper key
 * creation + envelope write); `false` means the rootkey was decrypted from
 * an existing envelope. NodeJSService surfaces this as span data on
 * `boot.rootkey-load` so first-install boots (where hardware-keystore
 * keygen can dominate boot time on some devices) are distinguishable in
 * Sentry from steady-state boots.
 */
data class RootKeyResult(val key: ByteArray, val generated: Boolean)

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

        /**
         * The three "v1" identifiers below describe **independent**
         * versioning axes. They share the value `1` today because we are
         * on the first release; they do not have to move together when
         * we change one without changing the others.
         *
         * - [WRAPPER_KEY_ALIAS]: identifies the AndroidKeyStore-managed
         *   wrapper key. Bump (`…-v2`) when the wrapper key's params
         *   change in a way that is incompatible with v1 envelopes —
         *   different algorithm, different key size, different
         *   `setUserAuthenticationRequired` / `setUnlockedDeviceRequired`
         *   flags, or any change that would invalidate existing v1
         *   ciphertext.
         *
         * - [PREFS_KEY]: the SharedPreferences key under which the
         *   encrypted envelope JSON is stored. Bump (`rootkey.v2`)
         *   only when we need v1 and v2 envelopes to coexist on the
         *   same install — e.g. a transitional migration that reads
         *   v1, decrypts, re-wraps under a v2 wrapper key, and writes
         *   to `rootkey.v2` while leaving v1 in place as a recovery
         *   hatch (see `docs/root-key-storage-and-migration-plan.md`
         *   §2.1). A simple format change that isn't migrating away
         *   from a still-readable previous version does **not** need
         *   to bump this.
         *
         * - [ENVELOPE_VERSION]: the integer in the envelope JSON's `v`
         *   field. Bump when the JSON shape itself changes — fields
         *   added, removed, renamed, or their semantics change.
         *   Decoupled from [WRAPPER_KEY_ALIAS] because a JSON-shape
         *   change doesn't necessarily require new ciphertext (and
         *   vice versa: a wrapper key rotation could keep the same
         *   envelope schema).
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
     * Returns the 16-byte rootkey + whether this call generated it.
     * Generates and persists on first launch. Synchronous; safe to call
     * from the FGS startup path. Throws on any failure path that would
     * otherwise risk silently fabricating a new identity.
     */
    @Throws(RootKeyException::class)
    fun loadOrInitialize(): RootKeyResult {
        loadExisting()?.let {
            log("RootKeyStore: native hit")
            return RootKeyResult(it, generated = false)
        }
        log("RootKeyStore: generated for first install")
        return RootKeyResult(generateAndPersist(), generated = true)
    }

    private fun loadExisting(): ByteArray? {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val raw = prefs.getString(PREFS_KEY, null) ?: return null
        val envelope = parseEnvelope(raw)
        val wrapperKey = loadWrapperKey()
            ?: throw RootKeyException("Wrapper key alias missing — keystore was wiped")

        // Validate the IV length before passing it to GCMParameterSpec.
        // GCMParameterSpec's constructor and Cipher.init throw plain
        // crypto-provider exceptions (e.g. InvalidAlgorithmParameter-
        // Exception) on malformed input; without this guard those
        // would escape the class as bare provider exceptions, breaking
        // the contract that all rootkey failures surface as
        // RootKeyException. Empty ciphertext is similarly caught here
        // rather than letting doFinal's later try/catch handle it,
        // because an empty `ct` field indicates envelope corruption,
        // not a decrypt failure.
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
        val wrapperKey = createOrLoadWrapperKey()
        // AndroidKeyStore-managed AES/GCM keys with
        // `setRandomizedEncryptionRequired(true)` (which we set in
        // `createOrLoadWrapperKey`) require the keystore to generate
        // the IV itself. Passing a `GCMParameterSpec` to `init()` on
        // encryption throws
        // `InvalidAlgorithmParameterException: Caller-provided IV not
        // permitted` on hardware-backed keystores (observed on API 30+).
        // We read the keystore-generated IV from `cipher.iv` after
        // `init()` and persist it in the envelope as before. Decryption
        // still requires the IV from the envelope — that's required by
        // GCM and allowed by the keystore.
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(Cipher.ENCRYPT_MODE, wrapperKey)
        }
        val ct = cipher.doFinal(plaintext)
        val iv = cipher.iv
        if (iv == null || iv.size != GCM_IV_LENGTH_BYTES) {
            // Defensive: AndroidKeyStore should produce a 12-byte
            // GCM IV, but `loadExisting` enforces the same length on
            // read so writing a different-length IV would silently
            // produce an unreadable envelope. Throw at write time.
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

        // Not using setUnlockedDeviceRequired(true): generation fails
        // on no-lock devices and disabling the lock later permanently
        // invalidates the key — both are identity loss. See PR #57.

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
        // Pinned to the only alias the v1 envelope can describe. If we ever
        // rotate to a v2 wrapper key, the version bump above gates the
        // mismatch path; this assertion catches a stored envelope whose
        // alias was tampered with or whose version field was truthful but
        // whose alias points at a key the keystore can't load.
        if (alias != WRAPPER_KEY_ALIAS) {
            throw RootKeyException(
                "Envelope alias mismatch: $alias (expected $WRAPPER_KEY_ALIAS)",
            )
        }
        // Base64.decode throws IllegalArgumentException on malformed
        // input. Without this catch, a tampered or truncated envelope
        // would escape the class as IllegalArgumentException rather
        // than RootKeyException, breaking the "all failures funnel
        // through RootKeyException" contract that callers rely on to
        // surface identity-load errors to the user.
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
