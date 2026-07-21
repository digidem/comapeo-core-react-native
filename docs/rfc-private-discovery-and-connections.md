# RFC: Private Peer Discovery and Connections

**Status:** Draft for review
**Scope:** `@comapeo/core` connection layer, `@comapeo/core-react-native` discovery layer, and the host app's discovery/sync UX
**Audience:** maintainers and reviewers of the CoMapeo sync stack

---

## 1. Summary

CoMapeo lets nearby and remote devices find each other and synchronise
encrypted project data. The privacy of that sync is currently bounded by
the connection layer underneath it: **today every local connection
reveals the device's permanent identity public key to whoever connects,
and the device name to whoever completes a connection.** That identity
key is the same key that identifies the device in reports and data
exports, so anyone who holds an export can correlate a named person's
device with network or (future) internet activity.

This RFC redesigns discovery and connections so that:

1. The **permanent identity key never appears on any wire** — local or
   internet — except inside an already-encrypted channel during a
   human-approved invite.
2. **Connecting to a stranger reveals nothing stable.** A device that is
   not a member of a shared project cannot complete a connection, learn
   an identifier, or elicit a device name.
3. **Membership is proven with per-project derived keys**, so proving "I
   belong to this project" never discloses "I am this specific device in
   your export," and a device cannot be correlated across the projects it
   belongs to.
4. **Discovery broadcasts carry no stable fingerprint** — only
   short-lived, rotating hints — while still letting members recognise
   each other and gossip sync state.
5. The change is **safe to roll out incrementally**, with a defined path
   for a mixed fleet of updated and not-yet-updated devices.

It applies uniformly across the discovery transports CoMapeo uses or
plans to use — local mDNS/DNS-SD, Bluetooth Low Energy, WiFi hotspot,
and Hyperswarm/DHT internet connectivity — because all of them feed the
same connection protocol.

---

## 2. Background: how it works today, and what leaks

Each device derives all of its keypairs deterministically from a 16-byte
root key (`KeyManager`, built on libsodium `crypto_kdf_derive_from_key`).
The **identity keypair**'s public key is the device ID shown in
reports/exports and is what a project's authorisation table stores to
authorise a member.

A local sync connection today does this:

1. A device discovers a peer (host-app mDNS advertising `_comapeo._tcp`)
   and opens a Noise connection over `@hyperswarm/secret-stream`, which
   defaults to the **XX** handshake pattern, using the **identity
   keypair** as the Noise static key (`local-discovery.js` →
   `keyManager.getIdentityKeypair()`).
2. XX exchanges both sides' static public keys, so **any device that
   completes the handshake learns the peer's permanent identity key** —
   and XX reveals the responder's static key to *any* initiator, member
   or not.
3. Each side eagerly sends an RPC `DeviceInfo` message with its **device
   name**.
4. Replication multiplexes all of a device's projects' cores over that
   single connection; data access is gated per-core by project
   capability.

### Leakage summary

| What leaks | To whom | Consequence |
|---|---|---|
| Permanent identity public key | Anyone who connects (local); anyone crawling the DHT (future internet) | Retroactive correlation with exports → tracking a named device's presence over time and place |
| Device name ("Maria's phone") | Anyone who completes a connection | Direct personal identification |
| Project key hashes / count | Any connected device | Mapping which devices share which projects |

The identity key is the worst offender because it is **stable,
meaningful, and present in exports**. Everything else is downstream of
fixing that.

Two facts about the current code make the redesign tractable:

- `KeyManager` already exposes deterministic **named-key derivation**
  (`deriveKeypair(name, token)`, `getDerivedKey(name, token)`), so
  per-project and rotating keys need no new secrets to back up or sync —
  they are re-derived from the existing root key.
- `secret-stream` accepts a `pattern` and a `keyPair`, and its
  underlying `noise-handshake` dependency already implements **PSK Noise
  patterns** (e.g. `XXpsk0`) with early PSK mixing. The cryptographic
  machinery this RFC needs largely exists; the work is in *which* keys
  and pattern are used, plus the surrounding discovery and migration
  logic.

---

## 3. Design principles

1. **The identity key is never a Noise static key.** Not on the LAN, not
   on the DHT. It is transmitted only during invite acceptance, inside an
   already-encrypted channel, after explicit human approval on both ends.
2. **Strangers get nothing.** A non-member cannot complete an
   authenticated connection, so an idle attacker learns no stable
   identifier and no name.
3. **Authenticate with per-project derived keys.** Membership is proven
   without revealing device identity, and per-project derivation prevents
   cross-project correlation.
4. **Discovery carries only rotating, non-reversible hints** — nothing
   derivable from data that appears in an export, nothing that forms a
   stable fingerprint.
5. **One multiplexed connection per peer pair is preserved.** The privacy
   gains must not cost the efficiency and simplicity of syncing all
   shared projects over a single stream.
6. **Migration is negotiated and per-project**, never a flag day.

---

## 4. Key model

Three classes of keypair, all deterministically derived from the
existing root key (nothing new to back up):

### 4.1 Identity keypair — unchanged role in *data*

- Public key = device ID in reports/exports; used for authorship and
  authorisation, as today.
- **Never used as a Noise static key.** Transmitted only during invite
  acceptance, inside an encrypted channel, after human approval.

### 4.2 Per-project connection keypair — new, derived

- Derived per project: `connKey_P = deriveKeypair("conn:" + projectId, …)`.
- Used as the **Noise static key for authenticated sync connections** to
  members of project P, on every transport.
- Registered in P's authorisation table alongside the identity key (one
  extra column: `connection_public_key`), so a peer validates the static
  key it sees against the project's members.
- **Per-project derivation prevents cross-project correlation:** the same
  physical device presents an unrelated static key in each project.
- Does **not** appear in exports, so it cannot be tied back to a named
  device in a report.

### 4.3 Per-project connection PSK — new, derived

- Derived per project from a **project-internal secret** (an encryption
  key shared only among members — *not* the project ID, which appears in
  exports), rotated on a coarse epoch: `psk_P = KDF(projectSecret_P,
  epoch)`.
- Mixed into the Noise handshake (§5) so that **a non-member cannot
  complete the handshake at all** and cannot read the static keys in
  transit.
- The PSK is no more sensitive than the project's data-encryption keys (a
  member already holds both), so binding the connection to it introduces
  no new secret-management burden and matches the existing trust model.

### 4.4 Ephemeral session keypair — new, random

- Randomly generated, rotated each app start (optionally per connection).
- Used as the **Noise static key for anonymous connections** to a device
  we share no project with — invite/onboarding, and the legacy probe
  (§9). Carries no long-term meaning and is registered nowhere.

---

## 5. Connection protocol

### 5.1 A PSK-bound handshake that still multiplexes projects

Authenticated sync connections use a **PSK-bound Noise handshake**
(`XXpsk0`), with the per-project **connection keypair** (§4.2) as the
static key and the per-project **PSK** (§4.3) mixed in.

In `XXpsk0` the PSK is mixed **before** any static key is transmitted.
Two consequences follow, and they are the whole point:

- **A non-member cannot complete the handshake** (they lack the PSK) and
  **cannot decrypt the static keys** in flight — so an attacker who dials
  the port learns nothing and cannot harvest a stable identifier. This
  closes the identity-leak-to-strangers hole that XX-with-identity has
  today.
- **A member authenticates mutually** via the per-project connection
  static keys (each validated against the project's authorisation table),
  with the identity key never on the wire.

Crucially, this preserves the **single multiplexed connection**. The PSK
authenticates the *connection* as being between two members of *one*
shared project; the per-core capability check still gates the *data* for
each project independently, exactly as today. So once two devices prove
they share **any one** project, all of their *other* shared projects
replicate over that same connection — each core still capability-gated.
A device therefore never needs more than one connection to a given peer,
regardless of how many projects they share.

> **Why not one connection per project?** Splitting projects across
> connections was considered and rejected for local sync: it multiplies
> handshakes and cipher state (costly on budget hardware), fights the
> grain of the replication stack (which multiplexes all cores over one
> stream), and buys only situational throughput isolation on lossy links.
> The PSK approach gets the security of per-project binding *without*
> giving up multiplexing. Performance analysis: on a low-latency local
> link the bottleneck is disk/verification and link contention, not the
> connection structure, so the single multiplexed connection is the right
> default.

### 5.2 Selecting the project without a trial

Because the PSK is mixed first, the responder must know *which* project's
PSK to use before it can reply — it cannot cheaply try every PSK in one
handshake. It doesn't need to: **discovery already tells the initiator
which project matched** (the daily project hash, §6), so the initiator
includes that 2-byte hash as a cleartext selector in the first handshake
message and the responder does an O(1) PSK lookup. The selector leaks
nothing new — that same hash is already broadcast in discovery, and on
the DHT the topic is already per-project — and it rotates daily. Clock
skew is absorbed by trying the selector against the small epoch-overlap
window (§6.3), a handful of symmetric operations, not a full trial.

### 5.3 Two connection types

- **Type A — authenticated sync** (a shared project is known): PSK-bound
  handshake as above. Deduplicated by the peer's per-project connection
  public key.
- **Type B — anonymous** (no shared project yet, or a stranger): Noise
  with the **ephemeral** static key. Reveals no stable identifier; used
  for invites (§7) and the legacy probe (§9). Deduplicated by IP:port
  with an ephemeral-key tiebreak.

### 5.4 Deduplication

With the identity key gone from the handshake, simultaneous
incoming/outgoing connections to the same peer are deduplicated by the
per-project connection key (Type A) or by IP:port with an ephemeral-key
tiebreak (Type B). Both are stable enough for the "keep one, drop the
duplicate" logic the stack already performs.

---

## 6. Discovery

Discovery's job is to answer "is a peer that shares a project with me
nearby/reachable, and does it have data I don't?" — without broadcasting
anything an observer can use to track a device or confirm project
membership over the long term.

### 6.1 Project matching, per transport

- **DHT / internet:** join a Hyperswarm **topic derived from the
  project-internal secret**, not the project ID. Topic membership *is*
  the project filter; peers on the topic share the project and connect
  Type A. (Deriving the topic from the project ID would let anyone who
  read an export join the topic and enumerate members — hence the
  secret.)
- **BLE:** the advertisement carries a **daily-rotated project hash** —
  `HMAC(projectSecret, UTC-day)` truncated to 2 bytes — plus a compact
  **sync-state hash** so a scanner learns not just "shares a project" but
  "and our states differ, worth connecting." A scanner matches the hash
  against its own projects' daily hashes.
- **mDNS / general fallback:** the advertisement carries no project hint.
  Connect first as an anonymous **Type B** connection, then privately
  determine shared projects *inside the encrypted channel* (§6.5), then
  run the Type A handshake for each match over its muxed channel.

### 6.2 The BLE advertisement carries no stable fingerprint

The advertisement is a small manufacturer-data payload (no 128-bit
service UUID, to save space; a short magic marker plus a version byte
identify it). It carries, per project being advertised: the daily project
hash, a sync-state hash, a coarse-bucketed data-volume indicator, and
device flags — **all rotating or non-identifying**:

- The **project hash rotates daily**, so a passive observer cannot use it
  as a stable identifier or confirm membership of a known project beyond
  the current day.
- The **sync-state hash is salted with the same daily epoch**, so it
  rotates too — otherwise a slow-changing state hash would be a
  cross-day fingerprint that survives the project-hash rotation.
- The **data-volume indicator is bucketed** (order-of-magnitude), not a
  raw count, so it is not a precise device fingerprint.

There is deliberately **no membership bloom filter in the broadcast**: a
bloom filter over a device's project set is a stable, multi-bit
fingerprint of exactly the thing we're trying not to leak, and is more
identifying than a single rotating hash. (A bloom filter *is* used, but
only inside the encrypted channel — §6.5 — where it is safe.)

### 6.3 Salt rotation period and overlap

The salt is a floored UTC epoch so two devices agree on it without
communicating — which ties it to the reality that field devices have
unreliable clocks (offline, drift, occasional time loss). The period
trades unlinkability against how badly clock skew breaks recognition:

| Period | Unlinkability | Skew tolerance (with overlap) | Verdict |
|---|---|---|---|
| 1 h | Excellent | ~1 h — too tight; a device off >1 h is invisible | Self-defeating |
| 6–12 h | Good/Moderate | 6–12 h | Viable if tighter unlinkability is wanted |
| 24 h | Modest | ~24 h; trivially simple ("today's date") | **Recommended default** |

The project hash is only 2 bytes and the BLE MAC already randomises, so
the period is a *secondary* privacy lever; the real cross-time
correlation risk lives in the state hash and volume fields, which §6.2
already rotates/buckets. Start at **24 h**; shorten only if a threat
review demands it.

**Overlap is necessary — but only on the scanning side, where it is
free.** A device *advertises* one epoch's hash (a single, cleanly
rotating value) but, when scanning, *accepts* the previous, current, and
next epoch (a few extra HMACs, cached). Without this, every epoch
boundary and any clock skew silently drops peers — the exact "discovery
is flaky" failure this design exists to avoid. Accepting more on the scan
side leaks nothing (scanning is passive and local) and costs no bytes.
The matched epoch also tells the scanner which salt the peer used, so the
state-hash comparison and the §5.2 handshake selector stay consistent
across the boundary.

### 6.4 Multiple projects per device

A device commonly belongs to 2–3 projects (>10 is rare). The BLE
advertisement holds one project hash at a time, so a multi-project device
**rotates through its projects, weighted toward the active one**, rather
than trying to encode all of them at once.

This scales gracefully because of §5.1: **finding one shared project is
enough** — it triggers the single connection, over which *all* shared
projects then replicate. So two devices only need one of their shared
projects to coincide in the rotation, and the scanner checks a peer's
single advertised hash against its whole project set at once. Expected
time to first contact is proportional to the number of projects on the
advertiser and inversely proportional to how many they share — fast for
the common case, merely slower (not broken) for the rare many-project
case. Weighting the active project keeps the everyday "sync the project
I'm looking at" case instant and full-featured.

### 6.5 Private multi-project matching on the mDNS path (in-channel)

When the transport gives no project hint (mDNS), two devices determine
shared projects *after* opening an anonymous Type B channel, by
exchanging an **epoch-salted bloom filter** of their project hashes over
the encrypted connection:

- Each builds a bloom filter over `hash(projectHash ‖ epoch)`, with the
  epoch carried in the message (single-epoch match, no skew guessing; a
  peer lying about its epoch only makes its own filter unmatchable).
- Tunable false positives provide privacy noise: an adversary probing the
  filter with guessed hashes cannot be sure which matches are real.
- A false-positive match is harmless — the per-project Type A handshake
  inside the muxed channel simply fails and the channel closes, revealing
  nothing.

This bloom filter is safe here precisely because it lives **only on the
encrypted connection**, never in a broadcast.

### 6.6 Connection address

Discovery must eventually yield an address to dial. On mDNS the resolved
service provides it. On BLE the advertisement can carry the device's
local address/port as a fast path. Because the handshake is now
PSK-gated (§5.1), exposing an address is low-risk: a stranger who dials
it cannot complete the handshake. The one residual concern is a *forged*
advertisement naming a third party's address to make many devices dial it
(a reflected-connection nuisance) — bounded by a **global rate limit on
outbound dials**, and only mountable by someone who already knows the
project's daily hash (i.e. a member/ex-member, not an anonymous
outsider).

---

## 7. Lazy device-name exchange and invites

The device name is never sent eagerly.

- On a **Type A** connection the name is not needed — attribution data is
  already in the project database.
- On a **Type B** connection the name is exchanged **only when both sides
  are in invite mode** (a human has opened the invite screen on each
  device):

  ```
  A (invite screen open) → invite_beacon
  B (invite screen open) → invite_beacon_ack
  A → device_info { name }        B → device_info { name }
  ```

- When a human sends and accepts an invite, the **identity public key and
  project key are transmitted inside this encrypted channel**, after
  explicit approval on both ends. The new member derives its per-project
  connection key and both devices register each other's identity +
  connection keys in the project's authorisation table. All subsequent
  connections for this project are Type A.

This is the only path on which the identity key is transmitted, and it
requires deliberate human action on both ends. An adversary sitting on an
idle Type B channel, or on any Type A channel, never receives a name or
an identity key.

The invite handshake is unauthenticated (ephemeral keys), so a MITM on a
Type B connection is theoretically possible; mitigations are that
acceptance is human-gated inside the channel and an optional short
verification code derived from the handshake hash can be shown for users
to compare. Type A connections are not exposed to this (mutual
per-project auth).

---

## 8. Internet / DHT sync is greenfield

CoMapeo does not yet ship internet connectivity, so **there is no legacy
to migrate on the DHT** — it can adopt this design from the first
release:

- Per-project **swarm topic derived from the project secret** keeps peer
  enumeration restricted to members.
- The **PSK-bound handshake** keeps the identity key off the public
  internet and prevents a DHT crawler from completing a connection or
  harvesting an identifier.
- The transport can use Hyperswarm's UDX (UDP-based, NAT-traversing)
  where it belongs — on the internet path. On the LAN, kernel TCP remains
  the right choice: UDX's hole-punching is moot on a local link and its
  userspace per-packet cost is a regression on budget devices.

The rest of this RFC's migration concern (§9) is therefore **local-only**.

---

## 9. Local migration: coexisting with not-yet-updated devices

This is the delicate part, because existing devices only understand the
current identity-key XX handshake, and we must not let the privacy
upgrade either (a) break sync with those devices or (b) leak a new
device's identity to an attacker *impersonating* an old device.

Terminology in this section: **new** = a device running the
privacy-capable version; **legacy** = a device running a current version.

### 9.1 Asymmetric discovery: new devices are invisible to legacy

- New devices **advertise on a new discovery identifier** (a distinct
  DNS-SD service type / a version-tagged record) and **speak only the new
  handshake on their listening port.**
- New devices **browse both** the new identifier (to find other new
  devices) **and the legacy identifier** (to find legacy devices) — but
  they **never advertise the legacy identifier.**
- Consequence: a legacy device cannot see or initiate to a new device.
  Every new↔legacy connection is **initiated by the new device**, and
  new devices act as a legacy **responder to no one.**

This asymmetry is a security property, not just a discovery detail. As a
legacy *responder*, a new device would be forced to send a static key in
the handshake before it could learn anything about the initiator — i.e.
it could not run the probe below and would leak. By only ever reaching
legacy peers *outbound*, the new device stays in control of when (and to
whom) it reveals anything.

### 9.2 The ephemeral probe: reveal identity only to a verified co-member

Legacy authentication recognises only the permanent identity key, so to
sync with a legacy co-member a new device must *eventually* present that
key. The risk is presenting it to an attacker posing as a legacy device.
The probe resolves this:

1. The new device connects outbound to the legacy-looking peer using an
   **ephemeral static key** (a legacy XX handshake). It thereby **learns
   the peer's identity key while revealing only an ephemeral, meaningless
   one.**
2. It checks that identity key against the authorisation tables of the
   projects it belongs to.
   - **Member of a shared project →** this is a genuine legacy
     co-member. The new device reconnects presenting its **real identity
     key** and syncs the shared project(s) over the legacy handshake.
   - **Not a member →** disconnect. Nothing stable was revealed.

Why this is safe against impersonation: an attacker can *present* any
identity **public** key in step 1, but the XX handshake proves possession
of the matching **private** key. The attacker does not hold a genuine
member's private key, so they can never pass the step-2 membership check
— and the new device never advances to step 3. The attacker learns only a
throwaway ephemeral key.

Why revealing identity to a verified co-member is acceptable: **co-members
already hold each other's identity keys** — they are stored in the
project's authorisation table, which syncs between members. So step 3
discloses nothing the co-member did not already have.

Cost: one extra handshake per new↔legacy connection. This is confined to
the migration window and to the specific peers that are still legacy.

### 9.3 Invites across the boundary

Invites happen before any shared project exists, so the membership check
cannot gate them. An invite involving a legacy peer therefore uses the
**anonymous ephemeral channel**, and the permanent identity is revealed
**only on explicit human acceptance** — identical in spirit to the
new-to-new invite flow (§7). This is acceptable because the disclosure is
consent-gated and an invite inherently establishes a trust relationship;
the ephemeral channel protects everything up to the moment a human on
both ends approves.

### 9.4 Per-project version floor: when a project becomes fully private

A single device is either new or legacy, but a *project* is a set of
devices. A project's authorisation/member records gain a **capability
flag** each device sets for itself (and which syncs with the other member
records). A project is **"fully private"** once **every** member record
is flagged privacy-capable.

- **Before** the floor is met, a project retains the legacy fallback: new
  members use the PSK handshake among themselves but reach the project's
  remaining legacy members via the §9.2 probe path. The project can
  surface its status to users — e.g. *"2 of 5 devices need updating for
  full privacy."*
- **Once** the floor is met, the project **drops the legacy fallback**
  entirely: all members are new, so every connection for that project is
  the PSK handshake, and the identity key never touches a connection for
  it again.

The floor is per project, so a device with a fully-updated project P and
a still-mixed project Q gets full privacy for P immediately while
retaining the fallback only for Q. Detection can be automatic (a device
locally observes that all member records are flagged) with an optional
admin confirmation step; the exact trigger is an open question (§12).

### 9.5 Migration security summary

- **Impersonation of a legacy device to elicit a new device's identity:**
  closed by the ephemeral probe (§9.2) — the attacker cannot pass the
  membership check.
- **Revealing identity to a legacy co-member:** no new leak — co-members
  already share identity keys via the synced authorisation table.
- **Legacy devices among themselves:** remain as exposed as they are
  today; this cannot be fixed without updating them, which is what the
  version floor drives toward.
- **A legacy device cannot initiate to a new device** (§9.1), so during
  the window a legacy member syncs with a new member only when the new
  member reaches out. This is a minor availability limitation, acceptable
  because sync sessions are typically mutual and active, and it disappears
  once the project's floor is met.

---

## 10. Backward compatibility and negotiation

Beyond the discovery asymmetry (§9.1), capability is negotiated so each
feature degrades independently:

- A **version hint** rides the discovery layer (DNS-SD service
  type/record, BLE flags/version byte, DHT topic versioning).
- On connect, a new device sends a **capabilities** message first
  (`{ version, lazyName, privateAuth, … }`). A legacy peer instead sends
  the eager `DeviceInfo` first; seeing `DeviceInfo`-first identifies a
  legacy peer and triggers per-feature fallback (accept the eager name,
  legacy auth, etc.).
- **Audit `remotePublicKey` consumers.** Any code that assumes the
  connection's remote public key is the identity key must change:
  long-term peer recognition must come from the project database (the
  identity key recorded at invite time), because the connection key is
  now a per-project connection key (Type A) or an ephemeral key (Type B).

---

## 11. Threat model after the changes

- **Passive local observer / DHT crawler:** sees per-project connection
  keys (not in exports, not correlatable to named devices, distinct per
  project) or ephemeral keys (meaningless), and rotating discovery hints.
  Cannot recover identity keys, cannot correlate a device across
  projects, cannot map network/DHT activity to exported device IDs.
- **Active attacker who connects (new-stack peer):** Type A requires a
  valid per-project PSK + connection key — a non-member cannot complete
  the handshake and learns nothing. Type B yields only an anonymous
  channel that stays idle unless a local human is in invite mode and
  approves.
- **Attacker impersonating a legacy device during migration:** cannot
  pass the ephemeral-probe membership check (§9.2); harvests only a
  throwaway key.
- **Adversary holding a CoMapeo export:** has identity public keys from
  the report, but those never appear on any connection or the DHT, so
  they cannot be used to track a device's presence. This is the primary
  threat the RFC closes.
- **Compromised member:** already holds the project's keys; the
  connection layer grants nothing beyond their existing access.

---

## 12. Rollout plan

The work is sequenced so that **each phase ships independent value** and
nothing depends on a fleet-wide flag day. Phases 1–2 are pure additions
with no protocol change; the privacy-affecting change lands behind the
per-project floor.

**Phase 0 — foundations (no behaviour change).**
- Add per-project **connection public key** and per-device **capability
  flag** columns to the authorisation records; populate on join and
  propagate via auth-record sync. Derive the connection keypair and PSK in
  `KeyManager` (context-string scheme fixed and documented).
- Audit and fix all `remotePublicKey` consumers to source long-term
  identity from the project database.
- *Ships:* schema + derivation groundwork, invisible to users.

**Phase 1 — private discovery (additive).**
- Rotating daily project hash + salted state hash + bucketed volume in the
  discovery layer; scan-side epoch overlap; multi-project rotation.
- New discovery identifier and asymmetric browse (§9.1) — new devices
  become invisible to legacy but still find them.
- *Ships:* discovery stops broadcasting stable fingerprints; still uses
  the current handshake, so no interop risk.

**Phase 2 — anonymous connections and lazy naming (additive).**
- Ephemeral Type B connections; lazy name exchange; invite-beacon flow;
  the ephemeral probe for outbound legacy connections (§9.2); in-channel
  bloom matching for the mDNS path.
- *Ships:* a new device stops revealing its name to idle peers and stops
  revealing identity to non-members — even before any project graduates —
  because the probe protects outbound legacy connections. Legacy interop
  unchanged.

**Phase 3 — PSK-bound authenticated sync (per-project).**
- The `XXpsk0` handshake with per-project connection key + PSK for Type A;
  the §5.2 selector; dedup by connection key.
- Activated **per project via the version floor** (§9.4): a project uses
  it once all members are capable; until then it keeps the legacy
  fallback for its legacy members.
- *Ships:* identity key leaves the connection for fully-updated projects;
  mixed projects keep working with graceful fallback.

**Phase 4 — internet / DHT (greenfield).**
- Per-project swarm topic from the project secret + the same PSK
  handshake + UDX transport. No migration; adopts the design directly.

**Phase 5 — retire legacy.**
- Once telemetry/version floors show adoption, deprecate then remove the
  legacy identity-key handshake and the probe path. At that point every
  connection has the full properties and the migration code is deleted.

---

## 13. Open questions / to verify

1. **PSK plumbing.** `secret-stream` does not currently expose the `psk`
   option that `noise-handshake` supports; confirm the minimal extension
   (or fork/PR) and that `XXpsk0`'s early-PSK placement gives the
   identity-hiding property as intended.
2. **Project secret for derivation.** Fix which project-internal secret
   derives the PSK, the DHT topic, and the daily hash, and confirm none is
   derivable from anything in an export. Define its rotation.
3. **Connection-key derivation context.** Finalise the
   `deriveKeypair` context scheme for per-project connection keys;
   guarantee determinism across app versions.
4. **Auth-record sync.** Define the schema + migration for the new
   connection-key and capability columns on existing projects.
5. **Version-floor trigger.** Automatic (all member records flagged) vs.
   admin-confirmed; how a re-added legacy device or a new member resets a
   graduated project; how the "N of M updated" status is surfaced.
6. **Bloom-filter parameters** for the mDNS path, validated against a
   realistic adversary probing model.
7. **Selector privacy on non-BLE transports.** Confirm the cleartext
   project-hash selector (§5.2) is acceptable on every transport (it is
   already exposed on BLE and via the DHT topic).
8. **Multi-project Type A ordering** when a peer shares several projects:
   which project's PSK selects the connection, and confirm all shared
   projects then replicate over it.
9. **On-device validation** of the discovery layer (advertisement packing,
   scan filtering, battery, concurrent radios) on representative budget
   hardware — the discovery hints and rotation are only as good as their
   behaviour on the target devices.
