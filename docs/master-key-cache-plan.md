# Master-key caching & KeyManager-from-master-key plan

Plan for eliminating the Argon2id root-key → master-key derivation from the
steady-state boot path, by (a) letting `@comapeo/crypto`'s `KeyManager` accept a
pre-derived 32-byte master key alongside the 16-byte rootkey, (b) keeping the
derivation itself in the Node backend, where it already happens, and sending
the result back to native over the control socket, and (c) caching it in the
native key stores next to the rootkey. Companion doc:
[root-key-storage-and-migration-plan.md](./root-key-storage-and-migration-plan.md)
(the rootkey store this plan extends).

Spans three repos: `@comapeo/crypto` (the `KeyManager` API change),
`@comapeo/core` (a small pass-through option on `MapeoManager`), and this
module (the cache stores, the new control frame, backend wiring).

---

## 1. Motivation

`KeyManager`'s constructor derives a 32-byte master key from the 16-byte
rootkey via libsodium `crypto_pwhash` — Argon2id with
`OPSLIMIT_INTERACTIVE` and `MEMLIMIT_INTERACTIVE`. `MEMLIMIT_INTERACTIVE` is a
**64 MiB** transient allocation plus meaningful CPU work; on low-end Android
devices this is a visible boot-time cost and memory spike.

Worse, the backend currently pays it **twice per boot**:

1. `createComapeo` → `MapeoManager` constructor → `new KeyManager(rootKey)`
   (inside `@comapeo/core`, `src/mapeo-manager.js:195`).
2. `createMapServer` → `new KeyManager(rootKey).getIdentityKeypair()`
   (`backend/lib/create-map-server.js:31`).

The derivation is deliberately expensive (see the rationale in
`@comapeo/crypto`'s `src/lib/key-utils.js`: pwhash raises the cost of
brute-forcing the 16-bytes-of-entropy rootkey → 32-byte master key mapping).
That defence matters for an attacker holding the master key's *derivation
inputs*, not for us re-running the KDF on every boot: the mapping is
deterministic and never changes, so the result can be computed once and cached.

**Caching the master key next to the rootkey does not increase the attack
surface.** Both live in the same store, wrapped by the same hardware-backed
key, and travel over the same app-private Unix socket. An attacker who can
read the cached master key can, by definition, read the rootkey beside it and
derive the master key anyway. What the rootkey retains uniquely is its role as
the **backup artifact**: it alone reconstructs everything, so it alone needs
to be written down. The master key cache is a pure performance cache —
derivable, disposable, safe to regenerate (unlike the rootkey, for which
regeneration is identity loss).

---

## 2. `@comapeo/crypto` changes

Target: `@comapeo/crypto@2.0.0` from
[`digidem/comapeo-crypto`](https://github.com/digidem/comapeo-crypto). The
package was renamed from `@mapeo/crypto` on merge, which is what makes the
release a major; the API changes themselves are additive and existing
16-byte-rootkey callers are untouched.

### 2.1 Accept a pre-derived master key

The constructor keeps its required 16-byte `rootKey` first parameter and
gains an explicit options parameter:

```js
/**
 * @param {Uint8Array} rootKey 16-byte root key. Always required — it remains
 *   the identity and the source of the backup code.
 * @param {object} [opts]
 * @param {Uint8Array} [opts.masterKey] Previously derived 32-byte master key for
 *   this same rootKey (e.g. read from a cache). When provided, the expensive
 *   Argon2id derivation is skipped and this value is used directly. The
 *   caller is responsible for it actually being
 *   `deriveMasterKeyFromRootKey(rootKey)` — see below.
 */
constructor(rootKey, { masterKey } = {}) {
  assert(rootKey.length === ROOTKEY_BYTES, `rootKey must be ${ROOTKEY_BYTES} bytes`)
  this._rootKey = rootKey
  if (masterKey) {
    assert(masterKey.length === MASTERKEY_BYTES, `masterKey must be ${MASTERKEY_BYTES} bytes`)
    // Defensive copy into a sodium secure buffer, matching the derived path.
    // `set`, not `copy`: key material often arrives from a native bridge as a
    // plain Uint8Array.
    this._masterKey = sodium.sodium_malloc(MASTERKEY_BYTES)
    this._masterKey.set(masterKey)
  } else {
    this._masterKey = deriveMasterKeyFromRootKey(rootKey)
  }
}
```

Design points:

- **`rootKey` is never optional.** Every instance can produce the backup code
  — `getIdentityBackupCode()` behaves identically whether or not the master
  key was supplied. No mode where a method "sometimes doesn't work".
- **No overloading, no length dispatch.** The two keys arrive in explicitly
  named positions with their own length assertions; a caller passing the
  wrong buffer in either slot fails loudly. Existing single-argument callers
  are byte-for-byte unchanged.
- **The rootKey/masterKey pairing is trusted, not verified.** Verifying would
  mean running the KDF, which defeats the purpose — that is inherent to any
  cache of an expensive derivation, not to this API shape. The contract is
  stated in the JSDoc, and coherence is enforced where the cache lives: the
  native stores bind the cached master key to its rootkey with a fingerprint
  and invalidate on any rootkey change (§ 5.3, § 6).

### 2.2 Expose the master key

Both of the following (they serve different callers and are each one line):

- **Method on the class** — `getMasterKey()`, returning a plain-`Buffer` copy
  of `_masterKey`. A method rather than a getter because it allocates. The
  copy is ordinary heap, not the instance's locked buffer, so the caller
  should zero it once it has been handed on.
- **Named export of `deriveMasterKeyFromRootKey`** from `src/index.js`. The
  function already exists in `src/lib/key-utils.js`; this just re-exports it.
  Used by tests, tooling, the backend's fallback path (§ 3.2), and any caller
  that wants the mapping without instantiating a `KeyManager`.

### 2.3 Tests (comapeo-crypto)

- **Equivalence suite**: for a fixed rootkey vector, assert
  `new KeyManager(rootKey)` and
  `new KeyManager(rootKey, { masterKey: deriveMasterKeyFromRootKey(rootKey) })`
  produce byte-identical results for `getIdentityKeypair()`,
  `deriveSwarmIdentity(fixedDate)`, `getHypercoreKeypair(name, ns)`,
  `getDerivedKey(name, token)`, **`getIdentityBackupCode()`**, and that
  `encryptLocalMessage`/`decryptLocalMessage` interoperate across the two
  instances. This is the identity-preservation guarantee the whole plan rests
  on.
- **Pinned derivation vector**: a hard-coded `(rootKey, expectedMasterKey)`
  pair asserting `deriveMasterKeyFromRootKey` output never drifts (guards
  against a sodium upgrade silently changing `crypto_pwhash` defaults —
  `PWHASH_ALG` is `ALG_DEFAULT`, which is version-pinned by sodium, but a
  vector makes any drift a loud test failure instead of fleet-wide identity
  loss). The **same vector** is reused by the backend's frame-encoding test
  (§ 4.4) — one vector, both call sites, locked together.
- Constructor rejects a non-16-byte `rootKey` and a non-32-byte
  `opts.masterKey` independently.
- Type declarations (`dist/`) updated; `npm run docs` regenerated.

### 2.4 Companion change in `@comapeo/core`

`MapeoManager` constructs `new KeyManager(rootKey)` internally
(`src/mapeo-manager.js:195`) and uses its `rootKey` option for nothing else,
so the pass-through is one option and one line:

```js
/**
 * @param {Buffer} [opts.masterKey] Previously derived 32-byte master key for
 *   `opts.rootKey`; skips the expensive derivation. See @comapeo/crypto.
 */
constructor({ rootKey, masterKey, ... }) {
  this.#keyManager = new KeyManager(rootKey, { masterKey })
```

Move core's exact-pinned `@mapeo/crypto@1.0.0-alpha.10` dependency to
`@comapeo/crypto@2.0.0` in the same PR — core imports `KeyManager`, `sign`,
`verifySignature`, and `keyToPublicId`, all present and API-compatible under
the new name, and the § 2.3 pinned vector plus the § 10
deviceId-stability test prove derivation output is unchanged across the jump
rather than assuming it. Released as a semver-minor of core (`7.5.0`).

---

## 3. Backend changes (this repo, `backend/`)

### 3.1 Init frame gains an optional `masterKey`

`backend/index.js` control-socket `init` handler:

- New optional field: `{"type":"init","rootKey":"<b64>","masterKey":"<b64>"}`.
  Native sends both keys on every boot where its cache has an entry — i.e.
  every boot after the first (§ 4).
- `rootKey` validation is unchanged and remains **fatal** on failure (it is
  identity).
- `masterKey`, when present, is validated with the same strictness — strict
  base64 of 32 bytes (`/^[A-Za-z0-9+/]{43}=$/`, decodes to exactly 32 bytes) —
  but failure is **non-fatal**: log + Sentry warning + metric, then proceed as
  if absent and re-derive from the rootkey. Cache semantics: a corrupt cache
  degrades to the slow path, never to a boot failure. (A malformed frame still
  indicates a native bug, hence the loud warning rather than silence.)
- `initPromise` resolves `{ rootKey, masterKey? }` instead of a bare buffer.

### 3.2 One shared `KeyManager`, derivation once per cache miss

In `backend/index.js` after `initPromise` resolves:

```js
const keyManager = masterKey
  ? new KeyManager(rootKey, { masterKey })            // cache hit: no pwhash
  : await sentry.withSpan("boot.master-key-derive",   // cache miss: measured
      () => new KeyManager(rootKey))
```

- The derive branch is the **normal first boot** after install, and the only
  place the derivation ever runs (§ 4). Seeing its span repeatedly on one
  install is the degraded signal, not seeing it at all.
- `createComapeo` gains an optional `masterKey` param and passes both
  `rootKey` and `masterKey` through to `MapeoManager`, which forwards them to
  its internal `KeyManager` via the § 2.4 core change. On the derive path,
  `index.js` passes its own `keyManager.getMasterKey()` as the option, so even
  then derivation happens exactly once, in exactly one place.
- `createMapServer` signature changes from `rootKey` to `identityKeypair`
  (or the shared `keyManager`); `index.js` passes
  `keyManager.getIdentityKeypair()`. **This deletes the second per-boot
  derivation entirely**, independent of caching.

### 3.3 Dependency wiring

- Backend direct dependency: `@comapeo/crypto` → `2.0.0` (for
  `createMapServer` / `index.js`'s own `KeyManager` and the exported
  `deriveMasterKeyFromRootKey` in tests).
- Backend `@comapeo/core` → `7.5.0` (the § 2.4 release), which brings its own
  `@comapeo/crypto@2.0.0`. No `overrides` gymnastics needed — the dependency
  graph converges on `2.0.0` naturally once core's exact pin on the old
  `@mapeo/crypto@1.0.0-alpha.10` is lifted upstream.
- If sequencing on a core release ever becomes a blocker, the backend's
  existing `patch-package` setup can carry the two-line § 2.4 core change as
  an interim patch — but the default plan is to land it upstream first; the
  change is small and strictly additive.

### 3.4 One new IPC frame

The protocol gains the optional `masterKey` field on the **existing** `init`
frame, plus one new Node → native frame:

```json
{ "type": "master-key", "masterKey": "<b64>" }
```

Sent immediately after `createKeyManager` resolves on a boot where the init
frame carried no usable master key — before `boot.manager-init`, because the
boot memory spike is where a low-end Android device gets killed, and a boot
that dies during manager construction should still leave the cache populated.

**Targeted, not broadcast.** The frame goes only to the connection that sent
`init`: on Android the main app process holds a second, read-only control
connection, and a broadcast would carry the key into a second process.
`SimpleRpcServer` passes each method handler the originating
`SocketMessagePort` for this; the `init` handler keeps it and drops the
reference on the port's `close` event, since `postMessage` on a closed port
fails asynchronously on the stream rather than throwing.

**Why this shape, given an earlier draft rejected it.** A middle version of
this plan derived the master key *natively* — Kotlin/Swift `dlopen`/`dlsym`
of exported wrappers in the sodium-native prebuild — precisely to avoid a new
frame, a native handler for a backend-originated secret, and an asynchronous
cache-populate window. Those costs are real but small; the cost that decided
it was upstream: native derivation needed a patched fork of
`digidem/sodium-native-nodejs-mobile` exporting five extra symbols, a
prebuild release on the critical path of every module release, a C shim and
JNI/SwiftPM target per platform, and on-device contract tests that stay red
until each prebuild refresh. Permanent maintenance overhead against a
one-time-per-install derivation. The three costs avoided all degrade to
"cache miss next boot", which self-heals, so they are accepted here.

### 3.5 Secret scrubbing

The master key is scrubbed everywhere the rootkey is:

- `backend/before-send.js` + `backend/lib/simple-rpc.js` (already logs routing
  fields only — the init frame is the single wire crossing for both keys).
- `src/sentry-scrub.ts`, `test-support/scrubber-cases.js` (add master-key
  cases — 43-char base64 and 64-char hex forms).
- `android/.../SentryMetricScrub.kt`, `ios/SentryMetricScrub.swift`.
- `scripts/sentry-tripwire.mjs` gains the master key as a tripwire secret.

---

## 4. Deriving in Node, caching in native

### 4.1 What the derivation is

`deriveMasterKeyFromRootKey` is one libsodium call — for these inputs,
exactly **Argon2id v1.3** (RFC 9106) with fully pinned parameters:

- password = empty (zero bytes); salt = the 16-byte rootkey
- opslimit (t_cost) = 2, memlimit (m_cost) = 64 MiB, parallelism = 1
- output = 32 bytes; algorithm = `crypto_pwhash_ALG_DEFAULT` = Argon2id13

Deterministic: identical inputs and parameters produce identical bytes in any
correct implementation.

### 4.2 One implementation, no new binary surface

The derivation stays exactly where it is today: inside `KeyManager`, in the
sodium-native addon the Node runtime already loads. Native code never runs
Argon2, so there is no second Argon2 implementation to keep equivalent, no
`dlopen`/`dlsym` of a prebuild's internals, no exported-symbol contract with
a forked prebuild, and no extra native target on either platform. Native's
whole job is to store 32 bytes and hand them back on the next boot.

The cost of that: the key crosses the control socket one extra time, in the
Node → native direction. It is the same app-private Unix socket the rootkey
already crosses in the other direction, with the same scrubbing rules
(§ 3.5), and it is targeted at the single connection that sent `init`
(§ 3.4).

### 4.3 Platform mechanics

Both platforms do the same three things on the `master-key` frame:

1. **Validate**: strict base64 of 32 bytes (`/^[A-Za-z0-9+/]{43}=$/`,
   decoding to exactly 32 bytes), then decode. Failure logs the string's
   length only, counts a metric, and drops the frame. iOS's
   `Data(base64Encoded:)` and Android's `Base64.decode` both accept input the
   backend could not have produced, so the character check is the gate, not
   the decoder. The `trailing-bits` round-trip check `parse-init.js` applies
   inbound is deliberately omitted here: the sender is our own backend, whose
   `Buffer.toString("base64")` always emits the standard encoding.
2. **Bind**: `storeMasterKey` takes the 8-byte rootkey fingerprint (§ 5.1),
   not the rootkey — by the time the frame arrives the rootkey has been
   zeroed. `sendInitFrame` computes and retains the fingerprint on **every**
   boot, before zeroing, so an inbound frame is always storable. The
   fingerprint is a truncated hash of a key that never leaves the device, so
   it is kept for the process lifetime rather than zeroed.
3. **Store off the receive path** (Android `serviceScope.launch` on
   `Dispatchers.IO`, iOS a utility queue): a StrongBox/keychain write plus a
   synchronous `commit()` can exceed 100 ms, and the `ready` frame follows
   almost immediately on a miss boot.

Nothing in this path can throw into the service: the stores already swallow
every failure (§ 5.2), and a dropped frame costs one derivation on the next
boot.

**Cost placement.** The one-time 64 MiB + CPU stays in the Node process, on
the boot where it already happens today. Nothing moves into the FGS/app
process.

### 4.4 Guards

- **Backend unit test** (`backend/lib/master-key-frame.test.mjs`): the pinned
  vector from § 2.3 encodes to a string that matches `parse-init.js`'s
  inbound `masterKey` regex and round-trips back through `parseInit` — the
  outbound and inbound validators are locked together, in the same test, in
  the same repo.
- **Native validator tests** (Android JVM `MasterKeyFrameTest`, iOS
  `NodeJSServiceTests`): valid vector accepted, bad alphabet / wrong length
  rejected, and a rejected frame never reaches the store and never disturbs
  the boot.
- No device-level contract test is needed: there is no second implementation
  and no external artifact to be in contract with.

### 4.5 Failure modes

Every failure degrades to "derive again on the next boot", and the next boot
is exactly when a `master-key` frame will be sent again — the loop is
self-correcting rather than needing a repair path:

- Frame never sent (backend killed between `createKeyManager` and the write),
  init connection already closed, or frame lost on a dying socket → no cache
  entry, next boot derives and retries.
- Frame arrives malformed → dropped with a metric; same outcome.
- Store write fails (keystore/keychain error) → the store logs, meters, and
  deletes the entry; same outcome.
- Cached entry later rejected by the backend (`parse-init.js`) → the backend
  derives *and sends a replacement frame*, so a corrupt cache self-heals on
  the boot that detects it.

---

## 5. Native storage — Android

Extends `RootKeyStore.kt` (same prefs file, same wrapper key, same envelope
code) rather than adding a sibling class.

### 5.1 Storage format

- **Prefs key:** `"masterkey.v1"` in `SharedPreferences("comapeo-core")`
  (already backup-excluded by the existing rules — no manifest change).
- **Envelope:** same JSON shape as `rootkey.v1` (`v`, `alias`, `iv`, `ct`)
  plus one field:
  - `fp`: base64 of the first 8 bytes of `SHA-256(rootKey)` — a binding
    fingerprint tying this cache entry to the rootkey it was derived from.
- **Wrapper key:** the existing `comapeo-rootkey-wrapper-v1` alias. No new
  keystore entries.

The fingerprint exists because cache coherence must hold even if a future
flow (e.g. backup-code restore) replaces the rootkey through a code path that
forgets to invalidate the cache. 8 bytes of a SHA-256 over 16 random bytes
identifies the key with negligible collision odds and negligible leak (the
preimage space is the full 128-bit key).

### 5.2 API

```kotlin
/** Cache read. Returns null on miss, decrypt failure, wrong length, or
 *  fingerprint mismatch against [rootKey] — deleting the stale entry and
 *  emitting a metric on the failure paths. Never throws: the master key is
 *  derivable, so unlike the rootkey there is no unrecoverable state. */
fun loadMasterKey(rootKey: ByteArray): ByteArray?

/** Cache write. Wraps, stamps [rootKeyFingerprint], commit()s, reads back
 *  and byte-compares (persistAndVerify pattern). Failure is logged, not
 *  thrown — the next boot simply re-derives. Takes the fingerprint rather
 *  than the rootkey because the caller zeroed the rootkey when it built the
 *  init frame; [fingerprintOf] is exposed for that caller. */
fun storeMasterKey(masterKey: ByteArray, rootKeyFingerprint: ByteArray)
```

Note the deliberate asymmetry with `loadOrInitialize()`: the rootkey store
throws rather than regenerate (identity loss); the master-key store swallows
and self-heals (pure cache). This asymmetry is the point of the design.

### 5.3 Invalidation invariant

**Any write of a rootkey value also removes `masterkey.v1`, in the same
`SharedPreferences` editor `commit()`** (both keys live in one file, so this
is atomic). That covers `generateAndPersist` (first install) and
`migrateFromLegacy` — today both write a rootkey the cache could not yet
exist for, so this is defensive, but it makes the invariant structural: the
shared `persistAndVerify(plaintext)` helper is where the `remove` goes, so no
future rootkey-writing path can forget it.

### 5.4 Service wiring (`NodeJSService.kt`)

On the backend's `started` frame, in `sendInitFrame()`:

1. `loadOrInitialize()` → rootkey (existing).
2. `loadMasterKey(rootKey)` → the cached master key, or null on a miss. The
   call is `Throwable`-guarded: a cache read can never fail the boot.
3. Retain `RootKeyStore.fingerprintOf(rootKey)`, build the init frame with
   `rootKey` + `masterKey` (when the cache hit), send it, zero both
   `ByteArray`s.

Then, on a miss boot, the backend's `master-key` frame arrives:

4. `ControlFrame.MasterKey` → validate + decode (`MasterKeyFrame.decode`) →
   `storeMasterKey(bytes, pendingRootKeyFingerprint)` on `Dispatchers.IO` →
   zero the bytes.

`ComapeoCoreModule.kt` — the main-app process's read-only observer of the
same socket — gets an explicit ignore branch for the frame, so the sealed
class's exhaustiveness check can't be satisfied by accidentally logging it.

---

## 6. Native storage — iOS

Mirrors Android in `ios/RootKeyStore.swift`.

- **Keychain item:** `kSecClassGenericPassword`, same service, account
  `"masterkey.v1"`, `AfterFirstUnlockThisDeviceOnly`, no biometrics.
- **Value layout:** 40 raw bytes — `fp(8) ‖ masterKey(32)`, where `fp` is the
  first 8 bytes of `SHA-256(rootKey)` (CryptoKit). The keychain value is
  opaque bytes, so the fingerprint is packed rather than enveloped; the
  account name carries the version.
- `loadMasterKey(rootKey:)` returns `nil` on `errSecItemNotFound`, wrong
  length, or fingerprint mismatch (deleting the stale item first). Keychain
  errors other than not-found also return `nil` (cache semantics) with a log —
  except during the store's rootkey path, whose strict error behaviour is
  unchanged.
- **Invalidation ordering:** keychain has no cross-item atomicity, so any
  rootkey write is preceded by deleting `masterkey.v1` (delete cache → write
  rootkey; a crash between the two leaves a missing cache, which self-heals,
  never a stale one — the fingerprint backstops even that).
- `storeMasterKey(_:rootKeyFingerprint:)` takes the fingerprint for the same
  reason as Android; `RootKeyStore.fingerprint(of:)` is exposed for the
  caller.
- `NodeJSService.swift`: same sequence as § 5.4 — cache read and fingerprint
  retention in `sendInitFrame`, then a `.masterKey` case in
  `handleControlMessage` that validates, decodes, and calls the injected
  `masterKeyStoreProvider` off the receive queue. `AppLifecycleDelegate`
  wires that provider to the same `RootKeyStore` singleton as the cache read.

---

## 7. Boot flows & migration strategy

There is **no data migration step**. The cache populates lazily; the rootkey
store (including the legacy `expo-secure-store` migration it already
performs) is untouched. Three states per boot:

1. **Steady state** (every boot after the first on the new version): rootkey
   hit + master-key hit + fingerprint match → init frame carries both →
   backend constructs `KeyManager` with the cached master key and sends no
   `master-key` frame. **No Argon2id, no 64 MiB spike, anywhere.**
2. **Cache miss** (first boot after upgrading to this module version; or
   after any invalidation/corruption): rootkey hit, master-key miss → init
   carries the rootkey only → the backend derives once under
   `boot.master-key-derive` → sends the `master-key` frame → native validates
   and caches it. Next boot is state 1.
3. **First install**: both miss → native generates the rootkey (existing
   path, which also clears any master-key entry per § 5.3) → proceeds exactly
   as state 2.

Properties worth stating:

- **Asynchronous cache population.** Unlike the rootkey, the cache is written
  after Node has booted far enough to derive, on a frame that can be lost.
  That window is why the frame is sent before `boot.manager-init` (§ 3.4) and
  why every failure in it is designed to land back in state 2.
- **Self-healing:** every failure mode (corrupt envelope, keystore hiccup,
  fingerprint mismatch, lost frame, process death before the cache write)
  degrades to state 2 on some boot, which re-derives and re-sends. No failure
  can block `ready`, and none can touch the rootkey.
- **Existing users pay the derivation exactly once more** (their first boot on
  the new version — the same cost every boot pays today, minus the duplicate),
  then never again.
- **Rootkey-only backup remains the whole story:** restoring a rootkey on a
  new device (whenever that flow exists) lands in state 2 and the master key
  re-derives. Nothing new needs backing up; the docs/UX story ("write down
  the backup code") is unchanged.

## 8. Version-skew and downgrade safety

- The backend bundle and the native code ship in the same module release, so
  neither side of the new frame can be present without the other.
- **Downgrade** (user installs an older app version after the cache exists):
  the old native code never reads `masterkey.v1` (unknown pref key / keychain
  account — inert bytes) and sends a rootkey-only init; the old backend
  ignores it entirely and sends no `master-key` frame (which the old native
  code would drop as an unknown frame type anyway). On re-upgrade the cache
  is either still valid (fingerprint matches) or self-heals. No compatibility
  hazard.
- **Old cache after this feature is ever revised:** version the prefs
  key/account (`masterkey.v2`) exactly as the rootkey scheme does.

---

## 9. Failure handling

| Case                                                        | Behaviour                                                                 |
| ----------------------------------------------------------- | ------------------------------------------------------------------------- |
| Master-key entry present, decrypt OK, fingerprint match     | Use it (state 1).                                                         |
| Master-key entry present, decrypt fails / wrong length      | Delete entry, metric, backend re-derives and re-sends (state 2).          |
| Fingerprint mismatch                                        | Delete entry, metric (this one is interesting — implies a rootkey change), state 2. |
| Init frame `masterKey` malformed (backend)                  | Sentry warning + metric, treat as absent, derive — and the resulting `master-key` frame replaces the bad entry. |
| `master-key` frame never sent (backend died first) or lost on a closing socket | Log + metric on the backend when the init connection is already gone; no cache entry, state 2 next boot. |
| `master-key` frame fails native validation                  | Log (length only) + metric, drop the frame; state 2 next boot.            |
| `master-key` frame arrives with no retained fingerprint     | Can't happen in order (init precedes it) — logged, metered, dropped.      |
| Native cache write fails                                    | Store deletes the entry, logs + metric; this boot is unaffected, state 2 next boot. |
| Rootkey failures (all)                                      | Unchanged — see root-key-storage-and-migration-plan.md § 7. Never affected by any cache state. |

---

## 10. Testing

- **comapeo-crypto:** § 2.3 (equivalence suite + pinned derivation vector are
  the critical two).
- **Backend unit tests** (`backend/lib/*.test.mjs` + index-level):
  - Init validation matrix for `masterKey` (absent / valid / bad base64 /
    wrong length) — asserting the non-fatal degrade path.
  - Cached boot constructs `KeyManager` with the supplied master key and
    runs no derivation; rootkey-only boot derives exactly once under the
    `boot.master-key-derive` span.
  - The outbound frame encodes to something `parseInit` accepts (§ 4.4), and
    a handler's reply reaches only the connection that called it — the
    property that keeps the key out of Android's main app process.
  - **deviceId-stability test:** with the upgraded dependency chain
    (`@comapeo/core@7.5.0` / `@comapeo/crypto@2.0.0`), a fixture rootkey
    produces the same `deviceId` from `MapeoManager` as recorded before the
    change — both with and without the `masterKey` option supplied (guards
    the alpha.10→1.2.0 jump and the pass-through in one assertion; this is
    the test that proves no existing user's identity changes).
  - Scrubber cases for master-key shapes (base64/hex) through the tripwire.
- **Frame validation** (§ 4.4): Android JVM `MasterKeyFrameTest` +
  `ControlFrameTest`; iOS `ControlFrameTests`.
- **Android instrumented** (`RootKeyStoreTest.kt`): store/load round-trip;
  corrupt envelope → null + entry deleted; fingerprint mismatch → null +
  deleted; rootkey write clears the cache in the same commit; wrong-length
  key and wrong-length fingerprint both rejected.
- **iOS XCTest** (`ios/Tests/`): same storage matrix; delete-before-write
  ordering; `NodeJSService` boot-sequence tests against `MockBackend.swift`
  asserting the init frame carries the cached key on a hit and the rootkey
  alone on a miss, plus a `master-key` frame reaching the store with the
  right bytes and fingerprint — and a malformed one reaching nothing.
- **e2e (`apps/e2e` + Maestro):** extend the existing rootkey-persistence
  flow (`maestro/rootkey-persistence.yaml`): boot → deviceId A → kill →
  boot → deviceId still A *and* the second boot's trace contains no
  `boot.master-key-derive` span (assert via the in-app suite's state/metrics
  hooks). DeviceId stability across the upgrade is the user-visible
  invariant.
- **Manual smoke:** install current release, boot (creates identity), upgrade
  to the build with this change, verify deviceId unchanged and second boot
  is derivation-free; then clear the master-key entry via adb and verify
  self-heal.

---

## 11. Rollout

1. Land + release `@comapeo/crypto@2.0.0` (§ 2.1–2.3). Nothing consumes the
   new surface yet; zero risk.
2. Land + release the `@comapeo/core` pass-through (§ 2.4) as `7.5.0`,
   depending on `@comapeo/crypto@2.0.0`. `masterKey` is optional, so this is
   inert for every existing core consumer.
3. Land the storage + frame + backend changes here (§ 3–6) in one PR: bump
   the deps, add the stores and the frame, wire the boot sequence. Ships as
   one module release — the protocol change is entirely internal to the
   module.
4. Beta-verify on a low-end Android device: first boot shows the
   `boot.master-key-derive` span once plus `masterkey.store ok`; subsequent
   boots show `masterkey.load hit`, an init frame carrying `masterKey`, and
   no derive span; boot-time and memory metrics (already collected via the
   Sentry boot trace) show the win.
5. Promote. No consuming-app changes, no coordination, no cleanup step.
   Watch `boot.master-key-derive` in telemetry — one per install is expected;
   a device emitting it every boot means its cache write or its `master-key`
   frame is failing (§ 4.5).

---

## 12. Out of scope

- **Backup-code UX** (surfacing `getIdentityBackupCode()` to the app). Out of
  scope for this plan, but explicitly kept easy by it: `rootKey` is required
  on every `KeyManager` (§ 2.1) and still travels in every init frame, so
  `getIdentityBackupCode()` works unconditionally on the backend's instance —
  exposing it to the app is just an RPC method, with no dependency on which
  boot state produced the instance.
- **Changing derivation parameters.** The pwhash params are vendored and
  frozen; changing them is identity loss by construction. This plan adds no
  coupling there — the derivation stays in the one place it already runs
  (§ 4.2), and the shared pinned vector (§ 2.3, § 4.4) locks the call sites
  together.
- **Rotating either key.** Unchanged from the rootkey plan § 13.
