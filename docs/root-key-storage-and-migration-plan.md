# Rootkey storage & migration plan

Plan for moving the 16-byte CoMapeo rootkey out of `expo-secure-store` and into
a Kotlin-native store owned by this module, so the foreground service (FGS) can
read it and start `nodejs-mobile` before React Native boots. Companion docs:
[ForegroundService.md](./ForegroundService.md),
[bare-architecture.md](./bare-architecture.md).

Covers Android (where there is an existing user base to migrate) and iOS (where
no version has shipped, so storage starts greenfield with no migration step).

---

## 1. Goal & constraints

- **Goal:** the FGS reads the rootkey synchronously during service startup, with
  no React Native involvement, no JS bridge, and no user interaction.
- **The rootkey is device identity.** It backs the device's authorization to
  every project it participates in. It cannot be rotated, regenerated, or
  recovered from a backup that doesn't already contain it. Losing it means
  losing the device's identity in those projects. This single fact drives most
  of the design choices below: no silent regeneration on error, no destructive
  migration, redundancy where cheap, paranoid validation of any byte-level
  transformation.
- **No biometrics, no user prompts.** A boot-time biometric prompt would defeat
  the purpose. The threat model is "device at rest is stolen," not "running app
  is compromised by another app on the same device." Sandbox + hardware-backed
  keystore + first-unlock gating cover that.
- **Existing-install migration must work on Android.** The current Android app
  stores the rootkey in `expo-secure-store`. We do not control the old app
  builds. They will never gain a "write to native store" code path. The module
  shipping this work is the first version that knows where the key actually
  lives.
- **One-shot, one-way migration.** After the first successful boot on the new
  module, the native store is the source of truth for reads. We do not write
  back to `expo-secure-store`, and we do not delete the legacy entry — see §
  2.1.
- **Don't brick anyone, ever.** A migration that fails (e.g. corrupted legacy
  entry, unexpected `expo-secure-store` layout, keystore wiped by a credential
  reset) must surface a clean error to JS, not silently regenerate and orphan
  the device's identity.

---

## 2. Three-state load algorithm (Android)

On every cold start, the FGS runs this in order. The whole sequence is two
`SharedPreferences` lookups in the steady state — microseconds.

1. **Native store hit (steady state, > 99% of boots after first migration).**
   Read the encrypted blob from our `SharedPreferences`. If present, decrypt
   with our `AndroidKeyStore` wrapper key. Done.
2. **Legacy hit (one-time migration path).** Native store is empty. Read the
   `expo-secure-store` `SharedPreferences` ("SecureStore" file) entry for the
   rootkey. If present, decrypt using the alias recorded in its JSON envelope,
   re-wrap with our key, write to the native store. Done.
3. **First install ever.** Both stores miss. Generate 16 random bytes via
   `SecureRandom`, wrap, write to the native store. Done.

Detection cost in the steady state is a single `prefs.contains(...)` followed by
a keystore decrypt. The legacy probe in step (2) only runs when step (1) misses,
so existing-install users pay it exactly once.

### 2.1 Idempotency and recovery hatch

We **do not delete the legacy entry** after migration, and the position is
permanent — not "revisit in a later release."

- Native-store-precedence already makes the migration idempotent: once step (1)
  hits, step (2) is unreachable. Leaving the legacy entry in place is harmless.
- Because the rootkey cannot be regenerated, the legacy entry is the only
  on-device recovery hatch if the native blob is ever lost or corrupted. The
  cost of keeping it (a few hundred bytes of `SharedPreferences` and one inert
  `AndroidKeyStore` alias) is trivial against the cost of identity loss.
- This means the load algorithm is technically four-state if we add a
  "native-blob-corrupted" recovery path. We can revisit that — see § 7.

### 2.2 Detecting "true first install" is reliable

A user who installed v1 (`expo-secure-store`), generated a rootkey, then
upgrades to v2 (this module) hits step (2). A user with no prior install hits
step (3). The two cases are unambiguous to the FGS. The one ambiguous case —
user cleared app data on v1, then upgraded to v2 — looks identical to a fresh
install, but that case already loses identity on the existing app today, so the
new module is no worse.

---

## 3. Where the code lives (Android)

A new Kotlin class:

```
android/src/main/java/com/comapeo/core/RootKeyStore.kt
```

Public API:

```kotlin
class RootKeyStore(private val context: Context) {
  /** Returns the 16-byte rootkey, migrating or generating as needed.
   *  Synchronous; safe to call from the FGS startup path. */
  fun loadOrInitialize(): ByteArray
}
```

It encapsulates: native read, legacy read+migration, generation, and wrapping.
Callers do not know which path produced the key.

### Call site

`NodeJSService.start()` (the JNI wrapper that boots Node) calls
`RootKeyStore(context).loadOrInitialize()` immediately before
`startNodeWithArguments(...)`. The key is held in a `ByteArray` (not a `String`)
for the brief window between read and handoff, then zeroed.

### How the key reaches Node

**Not** via argv (visible in `ps`) or env vars (visible in
`/proc/<pid>/environ`, inherited by children). Both are insecure even within the
app sandbox and don't add anything we couldn't do over IPC.

Instead: the existing state-channel Unix socket (`state.sock`, see
`NodeJSIPC.kt` and `lib/message-port.js`) gains a new init frame:

1. Node boots, opens the state socket, signals `{"type":"started"}` as today.
2. FGS responds with `{"type":"init","rootKey":"<base64>"}` as the first frame
   on the state channel.
3. Node receives, decodes, hands the bytes to `comapeo-core`, then broadcasts
   `{"type":"ready"}` as today.
4. FGS zeros its in-memory copy.

Unix socket file lives in the app's data dir, only readable by the app's UID. No
additional exposure beyond the IPC protocol that already exists.

`comapeoSocketPath` and `stateSocketPath` continue to be passed via argv — those
are paths, not secrets.

---

## 4. Native storage format (shared between Android & iOS where it makes sense)

### 4.1 Android wrapper key

- **Alias:** `comapeo-rootkey-wrapper-v1` in `AndroidKeyStore`. Versioned in the
  alias name so we can rotate the **wrapper** without touching the rootkey
  itself (re-decrypt, re-encrypt, swap alias). The rootkey itself is never
  rotated — see § 13.
- **`KeyGenParameterSpec`:**
  - `KEY_ALGORITHM_AES`, `KEY_SIZE = 256`
  - `BLOCK_MODE_GCM`, `ENCRYPTION_PADDING_NONE`
  - `setUserAuthenticationRequired(false)` (explicit — no biometrics)
  - `setUnlockedDeviceRequired(true)` on API 28+ (key only usable post first
    unlock since boot — matches iOS `AfterFirstUnlock` semantics)
  - `setIsStrongBoxBacked(true)` with `try`/fallback for devices without
    StrongBox (`StrongBoxUnavailableException`)
  - `setRandomizedEncryptionRequired(true)` (default; explicit for clarity)

### 4.2 Android encrypted blob

- **Storage:** `SharedPreferences("comapeo-core")`, key `"rootkey.v1"`.
  SharedPreferences gives us atomic writes and is simpler than rolling our own
  file.
- **Value:** JSON string

  ```json
  {
    "v": 1,
    "alias": "comapeo-rootkey-wrapper-v1",
    "iv": "<base64>",
    "ct": "<base64>"
  }
  ```

  - `v`: schema version. Bumped if we change layout.
  - `alias`: keystore alias used to wrap. Allows wrapper rotation.
  - `iv`: 12-byte GCM nonce, fresh per write.
  - `ct`: AES-256-GCM ciphertext including the 128-bit auth tag.

- **Cipher:** `Cipher.getInstance("AES/GCM/NoPadding")` with
  `GCMParameterSpec(128, ivBytes)`.

### 4.3 Backup exclusion (Android)

The native blob is useless without the wrapper key (which lives in
`AndroidKeyStore` and never leaves the device), but we still exclude it from
backup to avoid leaking metadata or muddying restore semantics:

- `data_extraction_rules.xml` (Android 12+) excluding
  `SharedPreferences/comapeo-core.xml`.
- `backup_rules.xml` (Android < 12) doing the same.
- Wired in `AndroidManifest.xml` via `android:dataExtractionRules` and
  `android:fullBackupContent`. The consuming app already controls `allowBackup`;
  we use exclusion rules rather than disabling backup wholesale.

---

## 5. Migration: decoding the `expo-secure-store` value (Android only)

### 5.1 What we read

- `SharedPreferences("SecureStore", MODE_PRIVATE)` in the consuming app's
  context (same UID, same data dir — accessible from our FGS).
- Two candidate pref keys, tried in order:
  1. `"<keychainService>-<keyName>"` — current `expo-secure-store` format.
  2. `"<keyName>"` — legacy bare key, kept for backwards compatibility by
     `expo-secure-store` itself.
- `<keychainService>` defaults to `"key_v1"` in `expo-secure-store`. The
  consuming app may have overridden it. **Open question — see § 10.**
- `<keyName>` is whatever the consuming app passed to
  `SecureStore.getItemAsync(...)`. **Open question — see § 10.**

### 5.2 What we decode

JSON envelope. For the AES path (API 23+, which is everything we support):

```json
{
  "scheme": "aes",
  "keystoreAlias": "<keychainService>",
  "usesKeystoreSuffix": true,
  "requireAuthentication": false,
  "ct": "<base64 ciphertext>",
  "iv": "<base64 iv>",
  "tlen": 128
}
```

Note the `keystoreAlias` field holds only the `<keychainService>` (e.g. `"key_v1"`),
**not** the full AndroidKeyStore alias — `SecureStoreModule.saveEncryptedItem` writes
`put(KEYSTORE_ALIAS_PROPERTY, keychainService)`. The full alias used to encrypt is
`"AES/GCM/NoPadding:<keychainService>:keystoreUnauthenticated"` (from
`AESEncryptor.getExtendedKeyStoreAlias`, with the `keystoreUnauthenticated` suffix when
`usesKeystoreSuffix` is true, which it always is on writes from expo-secure-store 56). We
reconstruct that full alias from `keychainService` + suffix — we do not read it from the
envelope.

_very_ old entries created on pre-API-23 devices may have `scheme: "hybrid"`. We
do not handle `hybrid` — the consuming app's `minSdk` is well above 23. If we
see it, we surface a clear error to JS rather than guess.

### 5.3 Decrypting

```kotlin
val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
// Reconstruct the full alias — the envelope's keystoreAlias field is only the service.
val alias = "AES/GCM/NoPadding:${envelope.keystoreAlias}:keystoreUnauthenticated"
val entry = ks.getEntry(alias, null) as KeyStore.SecretKeyEntry
val cipher = Cipher.getInstance("AES/GCM/NoPadding")
cipher.init(
  Cipher.DECRYPT_MODE,
  entry.secretKey,
  GCMParameterSpec(envelope.tlen, Base64.decode(envelope.iv, Base64.DEFAULT))
)
val plaintext = cipher.doFinal(Base64.decode(envelope.ct, Base64.DEFAULT))
```

If `getEntry` returns `null`, the keystore was wiped (some OEMs wipe keystore
entries on credential reset). The legacy ciphertext is unreadable and the user
has effectively lost their identity through OS-level events outside our control.
We surface a clear error and let JS decide UX — absolutely do not regenerate.

### 5.4 Re-wrapping

1. Generate or load our wrapper key (`comapeo-rootkey-wrapper-v1`).
2. AES-256-GCM encrypt the 16 plaintext bytes with a fresh 12-byte IV.
3. Write the JSON envelope to `SharedPreferences("comapeo-core")` under
   `"rootkey.v1"`.
4. **`commit()`, not `apply()`.** Synchronous, durable write before we proceed.
   Apply's async semantics are unacceptable here — if the process is killed
   between `apply()` and the write hitting disk, and we deleted the legacy entry
   (we don't, but in any future hypothetical), we'd lose the key.
5. Read back the blob, decrypt it, byte-compare to the plaintext we just wrote,
   before signalling success. Cheap paranoia given the stakes.
6. Zero the plaintext `ByteArray`.

---

## 6. Encoding: bytes vs. string

`expo-secure-store` stores strings. The consuming app calls
`SecureStore.getItemAsync(...)` and gets a string back; somewhere along the way
the 16 bytes are encoded into a string (most likely hex or base64). The Node
side gets a string today and decodes it as part of its current flow.

The native store holds raw bytes, not the string. To migrate, the FGS must
convert the legacy string back to the same 16 bytes the JS side currently hands
to `comapeo-core`. **Getting the encoding wrong silently produces a different
rootkey, which is identity loss.**

Mitigations:

- Pin the encoding from the consuming app's source (see § 10) before any
  release.
- Add a unit test with a known-good string from the consuming app and assert
  byte-for-byte equality after Kotlin decode.
- Sanity-check post-decode: if the result is not exactly 16 bytes, surface an
  error and abort migration — do not write a corrupt native blob.

An alternative considered and rejected: store the legacy string verbatim in the
native blob and let Node decode as today. Cleaner for Android migration but
introduces a string/bytes split between platforms (iOS is greenfield with raw
bytes) and complicates the IPC format. The risk of pinning the encoding wrong is
real but bounded by the test above.

---

## 7. Failure handling

| Case                                   | Behaviour                                                             |
| -------------------------------------- | --------------------------------------------------------------------- |
| Native blob present, decrypt OK        | Use it.                                                               |
| Native blob present, decrypt fails     | Try legacy (Android only) before giving up. Never regenerate.         |
| Native miss, legacy hit, decrypt OK    | Migrate, proceed.                                                     |
| Native miss, legacy hit, decrypt fails | Surface error. Don't regenerate.                                      |
| Native miss, legacy miss (Android)     | Generate. True first install — see § 2.2 for why this is unambiguous. |
| Native miss (iOS, no legacy concept)   | Generate. True first install.                                         |
| Legacy entry has `scheme: "hybrid"`    | Surface error (pre-API-23 entry on a device we don't support).        |

The "fall back to legacy on native decrypt failure" row is the recovery hatch
from § 2.1. It costs one extra `prefs.contains` on the unhappy path and protects
against transient native-blob corruption.

The "surface error" path keeps the FGS alive but signals via the state socket
that Node could not be initialised. JS can then prompt the user with whatever
recovery UX exists today — same surface that handles any other unrecoverable
crypto state.

We **never silently regenerate** on a decrypt failure. Generating a fresh
rootkey when an existing one is unreadable is identity loss and must be an
explicit, user-acknowledged action driven by JS, not the FGS.

---

## 8. Logging hygiene

- Never log the rootkey (plaintext or ciphertext), the wrapper key, or any
  derivative.
- Log only state transitions: `"rootkey: native hit"`,
  `"rootkey: migrated from expo-secure-store"`,
  `"rootkey: generated for first install"`,
  `"rootkey: decrypt failed (cause=...)"`,
  `"rootkey: legacy fallback triggered"`. These help support without leaking.
- Tag with the existing `log.kt` helper.

---

## 9. iOS plan (greenfield, no migration)

iOS has not shipped, so there is no prior `expo-secure-store` data to migrate.
The flow is just: read → if missing, generate → write.

### 9.1 Storage

- `SecItemAdd` / `SecItemCopyMatching` against `kSecClassGenericPassword`.
- Attributes:
  - `kSecAttrService` = bundle id, e.g. `"com.comapeo.app"`.
  - `kSecAttrAccount` = `"rootkey.v1"`.
  - `kSecAttrAccessible` = `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`.
    - `AfterFirstUnlock`: readable in the background once the user has unlocked
      at least once since reboot. Lets the iOS native bootstrap read the key
      without UI.
    - `ThisDeviceOnly`: never migrated via iCloud Keychain or device-to-device
      restore. Identity is per-install, per-device — matches the property we
      already enforce on Android (`ThisDeviceOnly` is the iOS equivalent of "key
      bound to this device's keystore").
  - **No** `kSecAttrAccessControl`. No biometrics, no user-presence flags.
- Value (`kSecValueData`): the raw 16 bytes. No JSON envelope, no IV, no
  ciphertext — Keychain handles encryption transparently.

### 9.2 Where the code lives (iOS)

A `RootKeyStore.swift` mirroring the Kotlin class:

```
ios/RootKeyStore.swift
```

```swift
final class RootKeyStore {
  /// Returns the 16-byte rootkey, generating on first launch if needed.
  func loadOrInitialize() throws -> Data
}
```

Called from the iOS native bootstrap that starts `nodejs-mobile` — specifically
before `nodeStartWithArguments(...)`, in
`application(_:didFinishLaunchingWithOptions:)` or the equivalent module init
point. The same state-socket init-frame protocol from § 3 carries the key from
native to Node.

### 9.3 Failure handling (iOS)

- `SecItemCopyMatching` returns `errSecItemNotFound` → first install, generate.
- `SecItemCopyMatching` returns any other error (e.g.
  `errSecInteractionNotAllowed` because the device hasn't been unlocked yet) →
  surface error, do **not** generate. We must not fabricate a new identity
  because the device is locked.
- `SecItemAdd` fails → surface error, do not retry-then-regenerate.

---

## 10. Open questions / inputs needed from the consuming app

These are values we need pinned down before writing migration code. They live in
the consuming app's repo, not here.

1. **Pref key name.** ✅ Resolved: `"__RootKey"` (not `"rootKey"`). Verified in
   comapeo-mobile `src/frontend/initializeNodejs.ts`: `getItemAsync("__RootKey")`.
2. **`keychainService` override.** ✅ Resolved: none — the app passes no options, so
   the expo-secure-store default `"key_v1"` applies.
3. **String encoding of the 16 bytes.** ✅ Resolved: hex.
   `uint8ArrayToHex(getRandomBytes(16))` on write, `Buffer.from(rootKey, "hex")` on the
   backend — a 32-char lowercase hex string.
4. **Recovery UX on unrecoverable decrypt failure.** What should the FGS signal
   to JS? Is there an existing "rootkey lost" flow? Given that the answer is
   probably "no, because it never happens today and there's no recovery anyway,"
   we may need to design one as part of this work.
5. **Known-good test vector.** A real (or test-fixture) 16-byte rootkey, the
   exact string `expo-secure-store` produced for it, and the resulting JSON
   envelope. Used to lock down the migration unit test.

Suggested artifact: a short companion doc in the consuming app's repo that pins
these down, committed alongside the implementation.

---

## 11. Testing

- **Unit tests** (Android `androidTest/`):
  - JSON envelope parsing for both legacy and current `expo-secure-store`
    formats.
  - Round-trip wrap/unwrap with our wrapper key.
  - Encoding round-trip for the consuming app's known-good test vector (§ 10).
  - Length-check: post-decode plaintext is exactly 16 bytes; otherwise abort and
    signal error.
- **Instrumented tests** on Android emulator:
  - First-install path: empty SharedPreferences → generate → read back.
  - Migration path: pre-seed `SharedPreferences("SecureStore")` with a
    handcrafted entry encrypted under a known alias, run `loadOrInitialize()`,
    assert native blob is written and plaintext matches the test vector
    byte-for-byte.
  - Steady-state path: after migration, second `loadOrInitialize()` returns the
    same bytes without touching `SecureStore`.
  - Native-corrupted path: write a garbage native blob alongside a valid legacy
    entry; verify the legacy fallback (§ 7) recovers cleanly.
  - Tampered legacy path: tampered ciphertext → error, not regeneration.
- **iOS unit tests** (XCTest):
  - First-install path generates and stores.
  - Steady-state path returns the same bytes.
  - `errSecInteractionNotAllowed` does not trigger generation.
- **Manual smoke test (Android):** install the previous app version, generate a
  real rootkey via the JS path, upgrade to the new module, verify the FGS reads
  it byte-for-byte and Node boots with the same identity.

---

## 12. Rollout

1. **Implement** `RootKeyStore` (Android + iOS) + wire into the FGS / iOS
   bootstrap + add the init frame to the state-channel protocol on both native
   and Node sides.
2. **Ship in a release of this module** consumed by a beta build of the app.
   Verify on Android with the migration smoke test on real devices that have an
   existing `expo-secure-store` rootkey. Verify on iOS that the greenfield
   generation path works.
3. **Promote to production** in the consuming app. Existing Android users
   migrate on first launch; new users (Android & iOS) hit the generate path.
4. The legacy `expo-secure-store` entry and its keystore alias are permanent
   leave-alone — see § 2.1. There is no later cleanup step.

---

## 13. Out of scope

- **Rotating the rootkey itself.** Not possible — the rootkey is the device's
  identity in every project it has joined. Anything that "rotates" it produces a
  new device identity, which is a different operation entirely (re-enrolment).
  The wrapper key (`comapeo-rootkey-wrapper-v1`) _is_ rotatable, since rotation
  just re-encrypts the same plaintext under a new alias — that's a separate
  operation if/when we ever need it (e.g. if Android deprecates the algorithm).
- **Hardware-attested keys.** StrongBox is opportunistic; we do not require
  attestation or gate functionality on it.
- **Backup/recovery of the rootkey itself.** Out of scope for this doc; whatever
  backup story the consuming app eventually offers is a separate feature. This
  doc only ensures that the rootkey, once it exists on a device, is held as
  durably as the local OS allows.
