# RFC: Private Peer Discovery and Connections

**Status:** Draft for review
**Scope:** `@comapeo/core` connection layer, `@comapeo/core-react-native` discovery layer, and the host app's discovery/sync UX
**Audience:** maintainers and reviewers of the CoMapeo sync stack

---

## 1. Summary

CoMapeo lets nearby and remote devices find each other and synchronise
encrypted project data. This RFC improves that in two directions at once,
because they are the same layer: **how devices find each other, and what
they reveal in doing so.**

**Discovery is too narrow today.** Local discovery is *mDNS-only*
(host-app advertising `_comapeo._tcp`), which fails on some networks and
routers, and can find a peer only when both devices already share a WiFi
network. This RFC adds **Bluetooth Low Energy as a second discovery
transport** — which works with the screen off, across the room, and
independent of any shared network — and adds **network-match detection**,
so a device discovered over BLE that sits on a *different* WiFi network is
identified as such instead of silently failing to connect. (Forming a
new WiFi network to bridge those devices — hotspot negotiation — is
deliberately **out of scope**; see Non-goals.)

**Discovery and connections are too revealing today.** Every local
connection **reveals the device's permanent identity public key to
whoever connects, and the device name to whoever completes a
connection.** That identity key is the same key that identifies the
device in reports and data exports, so anyone who holds an export can
correlate a named person's device with network or (future) internet
activity.

The RFC therefore has two thrusts that share one protocol:

*Discovery*

1. **BLE discovery** complements mDNS: peers are found across the room and
   with the screen off, not only when they already share a network.
2. **Sync-state gossip in discovery:** a discovery hint says not just "a
   peer that shares a project is here" but "and its data differs from
   mine," so a device knows whether a connection is worth making.
3. **Network-match detection:** a peer discovered over BLE but on a
   different WiFi network is surfaced to the user as such.

*Privacy*

4. The **permanent identity key never appears on any wire** — local or
   internet — except inside an already-encrypted channel during a
   human-approved invite.
5. **Connecting to a stranger reveals nothing stable.** A non-member of a
   shared project cannot complete a connection, learn an identifier, or
   elicit a device name.
6. **Membership is proven with per-project derived keys**, so proving "I
   belong to this project" never discloses "I am this specific device in
   your export," and a device cannot be correlated across projects.
7. **Discovery broadcasts carry no stable fingerprint** — only
   short-lived, rotating hints.

It is **safe to roll out incrementally**, with a defined path for a mixed
fleet of updated and not-yet-updated devices, and it applies uniformly
across every discovery transport — mDNS/DNS-SD, BLE, and Hyperswarm/DHT
internet connectivity — because all of them feed the same connection
protocol.

### Non-goals

- **WiFi hotspot / network formation.** When two devices share no
  network, *creating* one for them to sync over (local-only hotspot,
  multi-leader coordination, credential exchange) is a substantial topic
  of its own and is covered by a separate RFC. This RFC stops at
  *detecting* that peers are on different networks (§6.5).
- **Changing the data/replication or attribution model.** The identity
  key's role in authorship and authorisation is unchanged; only its
  presence on the wire changes.

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
  exports), on the **same daily epoch as the discovery hash**:
  `psk_P = KDF(projectSecret_P, epoch)`.
- Mixed into the Noise handshake (§5) so that **a non-member cannot
  complete the handshake at all** and cannot read the static keys in
  transit.
- The PSK is no more sensitive than the project's data-encryption keys (a
  member already holds both), so binding the connection to it introduces
  no new secret-management burden and matches the existing trust model.

**Clock skew and overlap.** Because the PSK is epoch-derived, two devices
on different epochs (near a boundary, or a skewed clock) would derive
different PSKs. This is absorbed by the very trial the responder already
runs to pick the project (§5.2): it tries its candidate PSKs across the
prev/current/next epoch window the scanner uses for discovery (§6.3), so
the epoch is found in the same loop as the project — no separate mechanism.
The initiator does not trial: having matched the peer's advertised hash
within its own overlap window, it already knows which epoch's PSK to build
the handshake with. So the handshake tolerates exactly the same skew as
discovery.

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

### 5.2 Selecting the project by trial decryption

In `XXpsk0` the PSK is mixed (`MixKeyAndHash`) at the very start of
message 1, so the responder must load *which* project's PSK before it can
process the message. The **initiator** has no such problem — discovery
already told it which project (and which epoch) matched (§6), so it builds
message 1 with that exact PSK. The only question is how the **responder**,
which may belong to several projects, finds the matching one.

**The responder trial-decrypts.** It buffers message 1 and replays it
against each of its own candidate PSKs — one per (project × epoch) across
the prev/current/next overlap window (§6.3) — until one verifies.
Verification is built in: message 1 ends with an AEAD tag over its
(possibly empty) payload, so the wrong PSK fails `decryptAndHash` and the
right one passes (`mixKeyAndHash(psk)` → read cleartext `e` →
`decryptAndHash`). Cost is O(*projects on this device* × 3) symmetric
verifies — a one-time, sub-millisecond step at connection setup for the
common 2–3 projects, which never recurs during the session. The
epoch-overlap window is absorbed into this same loop, so clock skew needs
no separate handling on the connection.

**No project marker goes on the wire, on any transport.** An earlier
approach put a cleartext 2-byte "selector" prefix ahead of message 1 so the
responder could skip the trial with an O(1) lookup. It isn't worth it: the
trial is negligible, and a fixed-format cleartext prefix is a standing
fingerprint — "this connection is CoMapeo, project = ⟨rotating hash⟩" —
readable by a passive observer or a DPI middlebox. On BLE/mDNS that leaks
nothing new (presence is already public there), but on the internet it
would throw away a central benefit of mixing the PSK first: that a
non-member sees *no* protocol marker at all (§8.4). Trial decryption gives
the same selection with nothing identifying on the wire **and a single code
path across every transport**, so it is the mechanism everywhere — no
selector, no prefix framing, no prologue binding.

**Selection is orthogonal to multiplexing.** Whichever project's PSK
completes the handshake, that one connection then multiplexes *all* shared
projects (§5.1), each core still capability-gated. The trial only decides
which PSK *opens* the connection, not which projects flow over it.

**The one case the trial can't cover** is when the initiator has *no*
discovery hint at all — the fully-private mDNS mode of §6.6 — because then
it doesn't know which project it shares and so can't pick a PSK to build
message 1. That case is resolved *before* the Type A handshake by the
in-channel bloom match of §6.6, over an anonymous Type B channel. Wherever
a discovery hint exists (BLE, mDNS TXT, DHT topic), the initiator knows the
project and only the responder trials.

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
- **mDNS:** carries the *same* rotating hint as BLE, in the service's
  **TXT records**. A DNS-SD TXT record is far roomier than a 31-byte BLE
  advertisement, so mDNS can carry a project's daily hash, its sync-state
  hash, the SSID hash (§6.5), and the version tag directly — a scanner
  matches and connects Type A without first opening a blind connection.
  (Because TXT has room for several hashes at once, whether to advertise
  one project or a small set is a privacy/latency trade — see §6.4.) The
  in-channel matching of §6.6 remains only as an optional fully-private
  fallback, not the primary mDNS path.

### 6.2 The discovery payload carries no stable fingerprint

The same payload rides both transports — a small manufacturer-data
blob on BLE (no 128-bit service UUID, to save space; a magic marker plus
version byte identify it) and TXT records on mDNS. Per project, it
carries the daily project hash, a sync-state hash, a coarse-bucketed
data-volume indicator, and device flags — **all rotating or
non-identifying**:

- The **project hash rotates daily**, so a passive observer cannot use it
  as a stable identifier or confirm membership of a known project beyond
  the current day.
- The **sync-state hash is salted with the same daily epoch**, so it
  rotates too — otherwise a slow-changing state hash would be a
  cross-day fingerprint that survives the project-hash rotation.
- The **data-volume indicator is bucketed** (order-of-magnitude), not a
  raw count, so it is not a precise device fingerprint.

There is deliberately **no membership bloom filter in any broadcast**: a
bloom filter over a device's project set is a stable, multi-bit
fingerprint of exactly the thing we're trying not to leak, and is more
identifying than a single rotating hash. (A bloom filter *is* used, but
only inside the encrypted channel — §6.6 — where it is safe.)

One nuance follows from mDNS's roomier records: advertising *several*
project hashes at once (which TXT allows but a BLE beacon does not) makes
the set of hashes a *within-day* correlatable fingerprint of a device's
project membership — the same objection as the bloom filter, just
readable by anyone on the LAN rather than in radio range. §6.4 covers
when that trade is worth taking.

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
The matched epoch also tells the initiator which salt the peer used, so the
state-hash comparison and the epoch's PSK for the §5.2 handshake stay
consistent across the boundary.

### 6.4 Multiple projects per device

A device commonly belongs to 2–3 projects (>10 is rare). The BLE
advertisement holds one project hash at a time, so a multi-project device
**rotates through its projects on a weighted round-robin**, rather than
trying to encode all of them at once.

**What "weighted toward the active one" means concretely.** The
advertiser re-broadcasts its manufacturer-data payload on a fixed cadence
(say every ~1 s, well under the BLE scan window). Each broadcast carries
one project's hash. Rather than a flat cycle `P1, P2, P3, P1, P2, P3…`,
the schedule is built so the **foreground project** (the one currently
open on screen, or most-recently synced if the app is backgrounded) takes
a majority of the slots and the rest cycle through the remainder:

```
active, active, P2, active, active, P3, active, active, P4, …
```

Implementation is a small weighted scheduler: assign the active project
weight *w* (e.g. 3) and every background project weight 1, then emit
project *i* for a fraction `weight_i / Σ weight` of broadcasts (e.g. an
interleaved/deficit round-robin so the active one is evenly spread, not
bursted). If there is no foreground project (backgrounded, or none opened
this session) the weights flatten to a plain round-robin. The weight is a
single tunable; `w = 1` degenerates to flat rotation.

This scales gracefully because of §5.1: **finding one shared project is
enough** — it triggers the single connection, over which *all* shared
projects then replicate. So two devices only need one of their shared
projects to coincide in the rotation, and the scanner checks a peer's
single advertised hash against its whole project set at once. Expected
time to first contact is proportional to the number of projects on the
advertiser and inversely proportional to how many they share — fast for
the common case, merely slower (not broken) for the rare many-project
case. Weighting the active project keeps the everyday "sync the project
I'm looking at" case near-instant even on a device carrying several
projects, while the background projects still get discovered within a few
rotation periods. (On mDNS this trade largely dissolves — TXT records can
carry several project hashes at once, §6.1 — so the rotation is a
BLE-specific accommodation of the 31-byte advertisement budget; see the
set-fingerprint caveat in §6.2.)

### 6.5 Network-match detection (different-SSID peers)

BLE discovery finds a peer *regardless of network*, which surfaces a case
mDNS never could: a co-member who is **in Bluetooth range but on a
different WiFi network** (or on no network). Today those two devices
cannot sync even though they can see each other, and — worse — the app
gives no signal about *why*. This section adds that signal.

- The advertisement (and the mDNS TXT record) carries a **2-byte
  daily-salted hash of the device's current network** —
  `HMAC(SSID/BSSID, UTC-day)` truncated — under the same epoch as the
  project hash (§6.3). It is a coarse *equality* token, not the network
  name: two devices on the same network derive the same 2 bytes; an
  observer cannot recover the SSID from it, and it rotates daily like
  everything else in the payload.
- A scanner compares the peer's network token against its own. **Same
  token → same network:** connect over mDNS/TCP as usual (BLE was just
  the finder). **Different token → different network:** the peer is
  surfaced to the user as *"nearby, but on a different WiFi network"*,
  rather than silently failing to connect.
- What the app does with that signal — prompt the user to join a common
  network, hand off to a hotspot flow, or just display it — is **out of
  scope** (that is the separate network-formation RFC, see Non-goals).
  This RFC's contribution is only the *detection*.

Platform notes: reading the connected network's identifier is
permission-gated — Android's `NEARBY_WIFI_DEVICES` (API 33+) or
coarse/fine location below it, iOS's `NEHotspotNetwork` /
`CNCopyCurrentNetworkInfo` entitlement. Where the identifier is
unavailable (permission denied, platform restriction), the device simply
**omits the network token**; a peer that sees no token treats network
match as *unknown* and falls back to today's behaviour (attempt the
connection, let it fail if unreachable). The feature degrades to exactly
the status quo, never worse.

### 6.6 Private multi-project matching on the mDNS path (in-channel fallback)

The primary mDNS path advertises project hashes directly in TXT records
(§6.1), so most matching needs no connection. This in-channel mechanism is
an **optional fully-private fallback** — used when a deployment chooses
*not* to expose any project hint in mDNS TXT (§6.2's set-fingerprint
concern), trading a little latency for leaking nothing to a passive
LAN observer. When engaged, two devices determine shared projects *after*
opening an anonymous Type B channel, by exchanging an **epoch-salted bloom
filter** of their project hashes over the encrypted connection:

- Each builds a bloom filter over `hash(projectHash ‖ epoch)`, with the
  epoch carried in the message (single-epoch match, no skew guessing; a
  peer lying about its epoch only makes its own filter unmatchable).
- Tunable false positives provide privacy noise: an adversary probing the
  filter with guessed hashes cannot be sure which matches are real.
- A false-positive match is harmless — the per-project Type A handshake
  inside the muxed channel simply fails and the channel closes, revealing
  nothing.

This bloom filter is safe here precisely because it lives **only on the
encrypted connection**, never in a broadcast — which is exactly why it is
*not* the mechanism used in the (broadcast) discovery payload of §6.2.

### 6.7 Connection address

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

This section covers when a device reveals its **name** ("Maria's phone")
and its **identity key**, both of which leak eagerly today (§2). The
answer depends on which of the two connection types from §5.3 is in play,
so as a reminder:

- A **Type A (authenticated sync) connection** is one where the two
  devices have *already proven they share a project*: the `XXpsk0`
  handshake completed, which means each side holds the other's per-project
  **connection** key and the shared **PSK**. They are known co-members of
  at least one project.
- A **Type B (anonymous) connection** is one where *no shared project is
  known* — a fresh contact, an onboarding/invite candidate, or a stranger.
  It is a plain encrypted channel built from **ephemeral** keys, so
  neither side has presented any stable identifier. It is the only channel
  available before membership exists.

The rule is: **the name and identity key are never sent eagerly on either
type; they are disclosed only by deliberate human action, and only over a
Type B channel.**

**On a Type A connection, neither is sent.** The name isn't needed —
attribution data is already in the project database that both members
sync — and the identity key stays off the wire entirely (that is the whole
point of the per-project connection key). Two co-members sync all their
shared projects without ever re-exchanging a name or an identity key.

**On a Type B connection, the name is exchanged only when both sides are
in invite mode** — i.e. a human has opened the invite screen on *each*
device. Until that mutual signal, a Type B channel stays silent and yields
nothing:

```
A (invite screen open) → invite_beacon
B (invite screen open) → invite_beacon_ack
A → device_info { name }        B → device_info { name }
```

**The identity key is transmitted only on invite acceptance**, still
inside that Type B channel, after an explicit human approve on both ends.
At that point the **identity public key and the project key** cross the
channel; the joining device derives its per-project connection key, and
both devices register each other's identity + connection keys in the
project's authorisation table. From then on, every connection for that
project is **Type A** — so the identity key is disclosed exactly once, to
exactly the person the user chose to invite, and never rides a connection
again.

This is the *only* path on which the identity key is transmitted, and it
requires deliberate human action on both ends. An adversary sitting on an
idle Type B channel — or on any Type A channel — receives neither a name
nor an identity key.

Because the Type B channel uses ephemeral keys, the invite handshake is
unauthenticated, so a MITM is theoretically possible on it. Two things
contain that: acceptance is human-gated *inside* the channel, and an
optional short verification code derived from the handshake hash can be
shown on both devices for the users to compare (a standard
authenticated-channel confirmation). Type A connections are not exposed to
this at all — they are mutually authenticated by the per-project keys.

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

### 8.1 Topic rotation and clock skew: not the same as BLE

The discovery layer rotates its project hint on a daily epoch and leans on
a **scan-side overlap** to absorb clock skew: a device advertises one
epoch's hash but *accepts* prev/current/next when scanning (§6.3). That
overlap is free on BLE and mDNS because **scanning is passive** — the
radio hears whatever is broadcast nearby and the device simply tries a few
extra HMAC matches locally. Widening the accept window costs nothing and
tells no one.

**Rotating a DHT swarm topic on an epoch does not inherit that free
overlap, because DHT rendezvous is not passive.** Hyperswarm joins a topic
in two roles:

- **`server` (announce):** you publish yourself on the DHT nodes closest
  to the topic, so others can find you. This is inherently *active and
  self-revealing* — to be discoverable on a topic you must advertise on
  it.
- **`client` (lookup):** you query those same DHT nodes for who has
  announced. Client-only mode lets you *find* announcers without
  announcing yourself — so there is a "look but don't advertise" mode — but
  it is still an **active query** that tells the ~handful of DHT nodes
  nearest the topic that you are interested in it. There is no primitive
  that "hears every topic and matches locally" the way a BLE scanner does.

Two consequences:

1. **You cannot make both sides passive.** For any connection at least one
   peer must be in `server` mode on the shared topic; if both are
   client-only, neither announces and neither is found. So the BLE model —
   everyone advertises one epoch, everyone accepts three — has no direct
   analogue.
2. **Naively "accepting ±1 epoch" means *announcing* on ±1 epochs**, and
   that actively undermines the rotation. Because epoch topics are
   deterministic, a watcher who holds the project secret and sees a node
   announce on both epoch *N* and epoch *N+1* can **stitch the rotation
   across the boundary** — pre-announcing the next epoch links the two
   identities, which is exactly the long-term linkage the rotation was
   meant to break.

### 8.2 How skew is actually handled on the DHT

The overlap is therefore made **asymmetric**, mirroring §9.1's shape:

- A device **announces (`server`) on its *current* epoch topic only** —
  never on an adjacent epoch — so it never pre-advertises a future topic
  and gives a secret-holding watcher no cross-boundary link.
- A device **looks up (`client`) on the previous, current, and next epoch
  topics**. Lookup is the cheaper, less-revealing role, and it is where
  the tolerance lives: if two peers are within one epoch of each other,
  at least one side's 3-topic lookup window covers the other side's
  single announce topic, so they find each other. (A finds B because A's
  lookup set `{N-1,N,N+1}` contains B's announce epoch; the reverse holds
  symmetrically.)

The residual cost is real but bounded: **~3× the lookup traffic** and a
disclosure of interest in three topics (rather than one) to the DHT nodes
nearest them — not zero, unlike BLE, but no extra *announce* footprint and
no cross-boundary announce-linkage. Because a 24 h epoch makes boundaries
rare, the widened lookup can be **restricted to a margin around the
rollover** (e.g. ±30 min) and collapse to a single-topic lookup the rest
of the day, cutting even that cost to a brief daily window.

### 8.3 Why a longer — or no — DHT epoch is defensible

Crucially, **on the DHT the topic's confidentiality does not come from
rotation in the first place — it comes from being derived from the project
secret.** A DHT crawler that does not hold the secret cannot compute the
topic at all, so cannot watch it, enumerate it, or connect (the PSK
handshake stops the last step regardless). Rotation on the DHT only
narrows a *narrower* threat: a party who *has* held the secret (a current
member, an ex-member, or a leak) watching a stable topic to observe which
members come online over time.

That is a weaker threat than the BLE physical-tracking case that motivates
a short epoch, so the DHT can reasonably trade some of it away:

- Use a **longer epoch on the DHT than on BLE** (say weekly, or even a
  fixed per-project topic), making boundaries rare-to-nonexistent and the
  skew problem nearly moot, at the price of coarser long-term
  unlinkability against a secret-holding watcher; **or**
- Keep a **stable per-project topic** for rendezvous and rely entirely on
  the PSK handshake for privacy — a crawler on the topic still cannot
  connect or identify anyone — accepting that a secret-holder could count
  online members.

The recommendation is to **decouple the DHT epoch from the BLE epoch**:
default the DHT to a long (weekly) or fixed topic to sidestep the skew and
announce-linkage cost, apply the asymmetric announce-current / lookup-±1
window only if a shorter DHT epoch is later justified, and treat the exact
DHT epoch length as an open question (§13) rather than inheriting BLE's
24 h by default.

### 8.4 The internet path carries no CoMapeo marker

Because project selection is by trial decryption on every transport (§5.2),
the internet path needs no special-casing — and it inherits an important
property for free. A distinctive benefit of mixing the PSK *before*
anything is transmitted is that, to a party without the PSK, the handshake
bytes carry no protocol version, no service name, **nothing that marks the
flow as CoMapeo.** That matters on the open internet, where a passive
observer or a DPI/censorship middlebox that could fingerprint "this is
CoMapeo" can throttle, block, or target its users. Since there is no
cleartext selector or any other fixed prefix ahead of the handshake,
message 1 is just an ephemeral key and an AEAD tag — no marker to match.
(On BLE/mDNS this property is moot, because the beacon and service record
already announce CoMapeo's presence.)

This is also *why* the responder must trial-decrypt on the DHT rather than
read the project from the rendezvous: **Hyperswarm does not surface the
discovery topic for an inbound connection** — an incoming connection
carries no indication of which topic led to it — so there is no out-of-band
shortcut, and the responder trials its PSKs exactly as it does on the LAN.
That is fine: the trial is O(projects) and one-time.

**Residual caveat — full indistinguishability is a bigger job.** Removing
any fixed prefix eliminates the *cheap, reliable* fingerprint, but it does
not by itself make the flow bytes uniformly random: `XXpsk0` message 1
still sends a raw ephemeral public key, and raw curve points are
statistically distinguishable from random to a determined DPI. Achieving
true "indistinguishable from random" additionally requires an
Elligator-style encoding of the ephemeral key (as pluggable transports do)
and traffic-shaping considerations — a substantially larger effort. This
RFC's goal for the internet path is the achievable one: **carry no trivial,
fixed CoMapeo marker.** Full obfuscation is noted as future work (§13),
not delivered here.

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

### 9.3 Invites across the boundary: require both devices to be capable

Invites are the one flow where the boundary cannot be made transparent,
and it is worth being precise about *why* — the answer falls out of how
the legacy invite protocol actually binds identity.

**How legacy invites bind identity.** On a legacy connection the peer
identifier used throughout the invite machinery *is* the connection's
Noise static key (`peerId = noiseStream.remotePublicKey`), which on the
legacy stack is the **permanent identity key**, exchanged in the XX
handshake **before** any human sees or accepts the invite. Invite
messages, the accept/reject, and the project-key hand-off are all keyed to
that peer. There is no point in the legacy protocol at which identity is
withheld and then "revealed on acceptance" — by the time the invite dialog
appears, both identity keys are already on the wire. So an ephemeral-key
channel *cannot* carry a legacy invite: the moment the new device presents
an ephemeral key as its static key, it is presenting that ephemeral key as
its identity, and the resulting membership records would authorise a
throwaway key rather than the device. This is a protocol fact, not a
tuning choice.

That forces the honest position: **an invite that must stay private
requires both devices to be privacy-capable.** Rather than silently
leaking identity to make a cross-version invite "work," a new device
detects the boundary and surfaces it.

- **New → legacy (new device wants to invite a legacy device):** the new
  device *can* see the legacy peer (it browses the legacy identifier,
  §9.1). But completing the invite on the legacy protocol means running
  the XX handshake with its **real identity key** up front — the very leak
  this RFC removes. So instead of doing that silently, the new device
  surfaces the peer with a blocking status: *"This device must be updated
  before it can be invited."* The invite proceeds only once that peer is
  new, at which point it is an ordinary §7 flow.
- **Legacy → new (legacy device wants to invite a new device):** the
  discovery asymmetry (§9.1) already prevents this — a legacy device
  cannot see a new device to start an invite, because new devices never
  advertise the legacy identifier. From the legacy user's side the new
  device simply isn't in the invite list; the new device can explain why
  (it knows it is hiding from legacy browsers) with the same *"update the
  other device"* guidance.

This is a deliberately accepted limitation, not a gap: during the
migration window, **forming a *new* project membership across the version
boundary is blocked, with a clear "must upgrade" prompt**, while *existing*
shared-project sync across the boundary keeps working via the ephemeral
probe (§9.2). Invites are rare, deliberate, human-driven events where a
one-time "update this device first" is acceptable; ongoing background sync,
which must not break, is precisely what §9.2 preserves. Once a project
meets its version floor (§9.4) the boundary is gone and invites are fully
private again.

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
- **Cross-version invites are blocked, not leaked** (§9.3): forming a new
  project membership across the boundary requires the other device to
  update first (the legacy invite protocol cannot hide identity). Existing
  shared-project sync across the boundary is unaffected — only *new*
  memberships wait for the upgrade.

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
  projects, cannot map network/DHT activity to exported device IDs. On the
  internet path, because no cleartext selector or protocol marker precedes
  the PSK-mixed handshake (§8.4), a crawler without the project secret also
  cannot cheaply fingerprint the flow as CoMapeo at all (full
  indistinguishability from random is future work, §13).
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

**Phase 1 — BLE discovery + private discovery hints (additive).**
- **Add BLE as a second discovery transport** alongside mDNS: a compact
  manufacturer-data beacon (§6.2) found with the screen off and across the
  room, managed by the same background sync service as mDNS.
- Rotating daily project hash + salted state hash + bucketed volume in the
  discovery payload, on both transports; scan-side epoch overlap (§6.3);
  weighted multi-project rotation on BLE (§6.4); project hashes in mDNS
  TXT records.
- **Network-match detection** (§6.5): the daily-salted network token, so a
  BLE-discovered peer on a different WiFi network is surfaced as such
  rather than silently unreachable.
- New discovery identifier and asymmetric browse (§9.1) — new devices
  become invisible to legacy but still find them.
- *Ships:* discovery works off-network and screen-off, stops broadcasting
  stable fingerprints, and explains different-network peers; still uses the
  current handshake, so no interop risk.

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
  responder-side trial decryption to select the project (§5.2); dedup by
  connection key.
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

1. **PSK plumbing + responder trial.** `noise-handshake` already ships the
   `XXpsk0` pattern and reads an `opts.psk`, but `@hyperswarm/secret-stream`
   does not thread it: its `lib/handshake.js` calls
   `new Noise(pattern, …, { curve })`. The change is a small, contained
   patch to thread `psk` through the `Handshake` wrapper and the
   `NoiseSecretStream` options — confirm as an upstream PR or a vendored
   shim. Because the project is selected by trial decryption (§5.2, no
   on-wire selector), the connection-setup layer must be able to **buffer
   message 1 and retry it** against each candidate PSK before committing to
   a `SecretStream` — verify secret-stream supports this cleanly (e.g.
   `autoStart:false` + deferred `start()` once the PSK is known, or a thin
   pre-read of the framed first message), and confirm `XXpsk0`'s early-PSK
   placement gives the identity-hiding property as intended.
2. **Project secret for derivation.** Fix which project-internal secret
   derives the PSK, the DHT topic, and the daily hash, and confirm none is
   derivable from anything in an export. Define its rotation.
2a. **DHT epoch length (decoupled from BLE).** Decide the swarm-topic
   rotation period independently of the 24 h discovery epoch (§8.3):
   long/weekly, fixed-per-project, or short-with-overlap. If short, confirm
   the asymmetric announce-current / lookup-±1 window (§8.2) and whether to
   restrict the widened lookup to a rollover margin. Validate against the
   secret-holding-watcher threat, which is the only one topic rotation
   addresses on the DHT.
3. **Connection-key derivation context.** Finalise the
   `deriveKeypair` context scheme for per-project connection keys;
   guarantee determinism across app versions.
4. **Auth-record sync.** Define the schema + migration for the new
   connection-key and capability columns on existing projects.
5. **Version-floor trigger.** Automatic (all member records flagged) vs.
   admin-confirmed; how a re-added legacy device or a new member resets a
   graduated project; how the "N of M updated" status is surfaced.
6. **mDNS TXT set-fingerprint policy.** Decide whether the mDNS TXT record
   advertises several project hashes at once (fast, but a within-day
   membership fingerprint to a LAN observer, §6.2) or a single rotating
   hash like BLE (private, slightly slower), and whether that is a global
   default or a per-deployment toggle that engages the §6.6 in-channel
   fallback. Set the **bloom-filter parameters** for that fallback against
   a realistic adversary probing model.
7. **Network token** (§6.5): confirm the SSID/BSSID source and the
   permission story on each platform (Android `NEARBY_WIFI_DEVICES` vs.
   location; iOS entitlement), and that omitting the token degrades
   cleanly. Decide the exact 2-byte derivation and whether BSSID (per-AP)
   or SSID (per-network) is the right equality granularity.
8. **Trial-decryption bound.** Confirm the per-inbound-connection trial
   cost — O(projects × epoch-window) AEAD verifies — is negligible on
   target hardware even for the rare many-project device, and that it adds
   no meaningful DoS surface beyond existing connection rate-limiting.
   (Hyperswarm does not surface the discovery topic for an inbound
   connection, so trial decryption — not out-of-band topic selection — is
   the mechanism on every transport, §8.4.)
8a. **Full flow indistinguishability (future).** Decide whether the
   internet path should go beyond "no fixed marker" to genuine
   indistinguishable-from-random — Elligator-encoded ephemeral keys and
   traffic shaping — as a pluggable-transport-style obfuscation layer, and
   whether that is in scope for a later phase or delegated to an external
   transport.
9. **Multi-project Type A ordering** when a peer shares several projects:
   which project's PSK selects the connection, and confirm all shared
   projects then replicate over it.
10. **On-device validation** of the discovery layer (advertisement packing,
   scan filtering, battery, concurrent radios) on representative budget
   hardware — the discovery hints and rotation are only as good as their
   behaviour on the target devices.
