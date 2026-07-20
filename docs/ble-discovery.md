# BLE Peer Discovery — Phase 1 design & implementation notes

This document accompanies the Phase 1 implementation of the "CoMapeo
Peer-to-Peer Discovery & Sync" proposal (BLE discovery + sync-state
gossip over existing WiFi). It records (1) a critical review of that
proposal, (2) the amendments Phase 1 makes as a result, and (3) what is
implemented in this repo and how it wires into the rest of the stack.

The proposal itself (external document) covers the full stack: BLE
discovery, WiFi hotspot formation, multi-leader coordination. Phase 1
is the independently useful slice: **devices on the same WiFi network
discover each other via BLE — replacing/complementing mDNS — and the
advertisement carries sync state, so peers know who has new data before
connecting.**

---

## 1. Review summary

The proposal's core architecture is sound and well-researched:

- The **BLE-discovers / WiFi-transfers split** is correct — the cited
  2–100 KB/s BLE throughput makes Hypercore sync over BLE a non-starter,
  and nobody should relitigate that.
- The **rejection of WiFi Direct / WiFi Aware / Multipeer** is
  well-sourced and matches field reality on budget MediaTek/MIUI
  hardware; `startLocalOnlyHotspot()` is the right primitive for the
  later phases.
- **Advertisement-carried sync state** (D2) is genuinely better than
  presence-only discovery, and the **write-then-notify** GATT credential
  pattern (D5) is the correct idiom for parameterised reads.
- The **phasing** is right: Phase 1 pays for itself even if the hotspot
  phases never ship.

The review found real gaps, though. In descending severity:

### R1 (blocking): the wire format carries no way to connect

Phase 1's goal is "feed discovered IP:port into the existing connection
pipeline", and Phase 3 has the leader "advertise its hotspot IP" — but
**no field in the proposed advertisement or scan response carries an IP
or port**. As specified, a scanner learns that a peer exists and differs
in sync state, but not how to reach it. mDNS would still be doing the
actual discovery, which defeats the phase's purpose on networks where
mDNS is broken (the motivating case).

**Amendment:** the v1 advertisement adds `ipv4` (4 bytes) + `port`
(2 bytes). Budget still closes: 21-byte payload, 28 of 31 advertisement
bytes used (§3).

### R2 (blocking): no version field

The proposed layout has magic bytes but no version. The first format
change would be silently mis-parsed by old clients as garbage field
values — in the field, across a 30-device group that never updates in
lockstep, this is guaranteed to happen.

**Amendment:** 1 version byte after the magic; decoders return `null`
(not-ours) for unknown versions.

### R3: the privacy story is internally inconsistent

D3's daily-rotated project hash is presented as the anti-tracking
mechanism, but the surrounding fields undermine it:

- The **scan response carries a stable 4-byte `shortPeerID`** — a
  permanent tracker that makes the daily rotation of the project hash
  cosmetic.
- `totalBlocks` + `stateHash` (6 bytes of slowly-changing,
  device-specific value) form a strong fingerprint that persists across
  the daily rotation boundary whenever a device isn't actively syncing.

This doesn't sink Phase 1 — BLE MAC randomization still limits passive
correlation, and the proposal's own out-of-scope note acknowledges a
connection-privacy work stream — but the claim "cannot use it as a
stable identifier for long-term tracking" is overstated and should not
be repeated to partners as a property of the system. Phase 1 drops the
`shortPeerID` (the IP:port serves dedup while on-network; it is
necessarily exposed anyway to be connectable). A future privacy pass
should consider epoch-salting `stateHash` the way the project hash is
salted.

### R4: iOS discovery is under-specified and partly contradictory

Three separate issues:

1. **iOS cannot see CoMapeo advertisements in the background at all.**
   CoreBluetooth background scanning requires a service-UUID filter;
   D1 removes the service UUID from Android advertisements, so iOS
   discovers Android peers only while foregrounded. Probably acceptable
   (iOS is scan-only and sync needs the app open anyway) — but it's a
   direct, undocumented consequence of D1 and must be a conscious
   decision.
2. **"iOS peers are discovered via their GATT service" is circular.**
   Android can only connect to an iOS GATT server it can *find*, which
   requires iOS to advertise *something* — i.e. the service UUID the
   design says nobody advertises. And when an iOS app advertises in the
   background, Apple moves the UUID to the overflow area, visible only
   to other iOS scanners — so background iOS devices are undiscoverable
   by Android regardless. The iOS-visibility story needs its own
   design round: foreground-only iOS advertising of the GATT service
   UUID appears to be the only workable option, and Android scanners
   will need a second scan filter for it.
3. **Duplicate-coalescing:** foreground iOS scanning without
   `allowDuplicates` coalesces advertisements, so sync-state *updates*
   (same device, new payload) can be delayed; the iOS scanner will need
   `allowDuplicates` and its battery cost accounted for.

Phase 1 therefore ships **Android-native only** (matching the
proposal's own build order); the JS layer is platform-neutral and
feature-detects.

### R5: Phase 3's cleartext password broadcast deserves a security note

The scan response broadcasts the hotspot password in cleartext "for
Android-to-Android joins". Anyone in BLE range — CoMapeo or not — can
then join the sync network. The network is local-only (no internet to
steal) and transport security ultimately rests on the Noise handshake,
but this design means: (a) the WiFi layer provides **zero** access
control, which must be an explicit assumption everywhere above it, and
(b) a trivial DoS exists (stranger occupies the ~5–8 client slots).
The per-project *encrypted* GATT path already specified should be the
default, with the cleartext fast path a measured optimisation decision,
not the default.

### R6: minor corrections / open items

- **"Every device computes [leader election] from the shared view of
  advertisements — no negotiation"** assumes a consistent shared view
  that lossy BLE scanning does not provide; two candidates *will*
  occasionally both self-elect. Phase 3 needs an explicit
  detect-and-yield rule (e.g. higher-priority leader wins, other tears
  down), not an assumption of convergence.
- **D2 overclaims slightly:** a differing `stateHash` means "states
  differ", not "peer has data *I* need" — the correct action (connect
  and reconcile) is the same, but UX copy like "N devices have new
  data" shouldn't be built on it.
- **SSID equality ≠ connectable:** same SSID can be different networks,
  and AP/client isolation (common on public/guest networks) breaks
  peer-to-peer TCP on a *shared* SSID. Phase 2's "different network"
  hint is fine; a "same network so it must work" conclusion is not.
- **2.4 GHz coexistence** (BLE advertise/scan + WiFi sync concurrently
  on budget single-antenna chipsets) belongs on the open-questions
  list alongside Q8.
- **D8 (company ID 0xFFFF):** the Bluetooth spec reserves 0xFFFF for
  internal testing "and shall not be used in shipping products". With a
  "CM" prefix filter the practical collision risk is low, but a SIG
  membership + company ID (US$0 for the membership tier CoMapeo likely
  qualifies for, else the cited fee) should be budgeted before wide
  release; it's a two-constant change (`backend/lib/ble-codec.js`,
  `android/.../BleProtocol.kt`).
- **D9 (separate `expo-ble-advertiser` repo):** reasonable end-state,
  premature start. A separate repo means separate release/version
  coordination while the wire format is still moving. Phase 1
  implements in-repo (`src/ble/` + `android/.../ble/`, JS-only tests
  run in the existing fast lane); extraction is mechanical later if
  reuse materialises.

---

## 2. Phase 1 scope as implemented

| Piece | Status |
|---|---|
| v1 wire format (amended: version byte, ipv4+port, no shortPeerID) | ✅ `src/ble/wire-format.ts` |
| Hash derivations (daily project hash, state hash, SSID hash) | ✅ `src/ble/hashes.ts` (pure TS, FIPS/RFC-4231-verified) |
| Discovery manager (peer table, RSSI smoothing + cluster hysteresis, expiry) | ✅ `src/ble/BleDiscovery.ts` |
| Android advertiser (manufacturer data, balanced/high-TX, non-connectable) | ✅ `android/.../ble/BleAdvertiser.kt` |
| Android scanner (hardware filter: company 0xFFFF + "CM" mask) | ✅ `android/.../ble/BleScanner.kt` |
| **Background discovery**: radios in the `:ComapeoCore` FGS + backend auto-connect | ✅ `BleDiscoveryEngine.kt`, `backend/lib/ble-discovery.js` — see §4a |
| **Backend discovery controller** (lifecycle, composition, peer table, persistence) | ✅ `backend/lib/ble-discovery.js` — §6 implemented |
| **Front-end surface**: `discovery` RPC namespace + `discovery-state` events | ✅ `src/discovery.types.ts`, `comapeoServicesClient` — no native module |
| **iOS foreground engine** (scan + service-UUID advert + GATT sync-state server) | ✅ `ios/BleDiscoveryEngine.swift` — §6c implemented |
| **Android GATT read path** for iOS peers (second scan filter + reader) | ✅ `android/.../ble/GattStateReader.kt` |
| iOS background discovery | ❌ by design for now — §6c wake-path options |
| Scan response (SSID hash, credentials) | ❌ Phase 2/3 (and see R5) |
| Backend `MapeoManager` API changes | none — the backend only *calls* `connectLocalPeer` |

The GATT server is deliberately **not** in this phase even though the
proposal's build order lists it: its only Phase 1 consumer is the iOS
path, which R4 shows needs re-design first. Shipping an unused GATT
surface now would freeze wire decisions the iOS round should own.
Android-to-Android discovery — the dominant field case — is complete
without it, and the advertisement stays non-connectable (cheaper, and
nothing to probe) until GATT lands.

## 3. v1 wire format (normative)

Manufacturer-specific data, company ID `0xFFFF`, no service UUID
(D1 unchanged). Payload after the company ID, all multi-byte fields
big-endian:

```
offset len  field
0      2    magic "CM" (0x43 0x4d)
2      1    version = 0x01
3      2    projectHash   HMAC-SHA256(projectKey, "comapeo-ble-v1:project:"+UTC day)[0..2]
5      4    totalBlocks   Hypercore blocks held (saturates at 2^32−1)
9      4    stateHash     SHA-256("comapeo-ble-v1:state:"+canonical state)[0..4]
13     1    battery       bit7 = charging; bits 6..0 = percent (0–100), 127 = unknown
14     1    flags         bit0 isHotspotLeader, bit1 hasWifi, bit2 inviteMode; rest 0
15     4    ipv4          sync-interface address; 0.0.0.0 = none
19     2    port          local peer-discovery server TCP port; 0 = not listening
            = 21 bytes  (28 of 31 advertisement bytes incl. flags AD + headers)
```

Decoders MUST treat wrong magic, wrong length, or unknown version as
"not a CoMapeo advertisement" (return null), never as an error — other
apps legitimately use company ID 0xFFFF. All hash derivations are
domain-separated under the `"comapeo-ble-v1:"` prefix. The normative
codec lives in `backend/lib/ble-codec.js`.

**Hash inputs as implemented** (the backend composes; see §4a):

- `projectHash` secret = utf8 bytes of the **project public ID** (a
  one-way blake2b of the project key — the raw key isn't reachable
  through the public manager API). Every member knows the public ID; a
  passive BLE observer doesn't. It leaks more easily than the raw key
  (URLs, logs), so migrating to a core-provided discovery secret is
  flagged for the privacy pass.
- `stateHash` input = newline-joined **sorted `versionId`s of
  observations + tracks** (incl. deleted). Two fully-synced devices
  hash equal; blob-only divergence isn't captured (doc-level diff is
  the connect trigger; blob sync follows the connection).
- `totalBlocks` currently carries the **doc count**, not Hypercore
  blocks — advisory "how much data" only.
- `batteryPercent`/`charging`/flags advertise as unknown/false until
  Phase 3 election needs them (planned: native stamp of byte 13).

**GATT identifiers** (iOS discoverability, §6c):

```
Service         c3992d3b-af17-484c-ab89-24ae377279d4   (advertised by iOS)
├── Sync State  1e2909d4-767b-4635-affe-97f936b91a48   (read → the 21-byte v1 payload)
```

## 4. Integration model

The backend's **discovery controller** (`backend/lib/ble-discovery.js`)
is the single owner: lifecycle, advertisement composition (from `$sync`
docs, the project public ID, `os.networkInterfaces()`, and core's
local-peer server port), the peer table, and the auto-connect policy.
Native engines are dumb radio drivers it commands over the control
socket; the front end observes and controls over the app-services RPC.
There is **no discovery-specific native module** — see §6 for why.

Host wiring, complete and platform-branch-free:

```ts
import { comapeo, comapeoServicesClient } from "@comapeo/core-react-native";
import { ANDROID_BLE_PERMISSIONS } from "@comapeo/core-react-native";
import { PermissionsAndroid, Platform } from "react-native";

// 1. Permissions are the host's UX (they need an Activity). iOS
//    prompts by itself on first use (plugin injects the usage string).
if (Platform.OS === "android" && Platform.Version >= 31) {
  await PermissionsAndroid.requestMultiple([...ANDROID_BLE_PERMISSIONS]);
}

// 2. Turn discovery on. The backend starts core's TCP server, composes
//    and broadcasts the advertisement, switches the radios on, and
//    persists the choice (an FGS restart resumes by itself).
await comapeoServicesClient.discovery.setEnabled(true);

// 3. Observe. Nearby (anonymous) peers + radio status/blockers:
comapeoServicesClient.on("discovery-state", ({ peers, ble }) => {
  renderNearby(peers);                    // sameProject / inCluster / rssi
  renderBlockers(ble.blockers);           // "bluetooth-off" → prompt UX
});
// Connections need no wiring at all — the backend auto-connects
// same-project peers; they surface through the manager as ever:
comapeo.on("local-peers", (peers) => renderConnected(peers));
```

### 4a. Process model & background discovery

Background discovery is a Phase 1 requirement: the whole point of the
Android dual-process design is that sync survives backgrounding, and
discovery must survive with it — devices should keep finding each
other and syncing with the app in the pocket. Radios in the main app
process would die exactly when the FGS keeps syncing. So:

```
main app process                 :ComapeoCore FGS process (Android)
┌─────────────────────────┐      ┌────────────────────────────────┐
│ host app JS             │      │ Node backend                   │
│  comapeoServicesClient  │      │  lib/ble-discovery.js          │
│   .discovery.setEnabled ├──────▶  DiscoveryController           │
│   .on("discovery-state")◀──────┤   compose ▸ decide ▸ connect   │
│  comapeo.on("local-     │ RPC  │   persist enabled flag         │
│   peers") (connections) │      │      │ ble-start/-advertise/   │
└─────────────────────────┘      │      │ -stop   ▲ ble-sighting/ │
                                 │      ▼         │ ble-status    │
   (iOS: same picture, all       │  BleDiscoveryEngine            │
    in one process; Swift        │   BleAdvertiser + BleScanner   │
    engine, same frames)         │   + GattStateReader (iOS peers)│
                                 └────────────────────────────────┘
```

- **Radios** live in [`BleDiscoveryEngine`] inside the FGS process
  (and, on iOS, `BleDiscoveryEngine.swift` in-process), driven by
  `ble-start` / `ble-advertise` / `ble-stop` control frames from the
  backend. The Android service starts `dataSync`-only and re-promotes
  itself with the `connectedDevice` FGS type once BLE starts and a
  Nearby-devices permission is granted (API 34 enforces the
  prerequisite at `startForeground` time).
- **Policy and composition** live in the backend controller: it
  composes the advertisement itself (so it stays fresh in the
  background — no staleness), receives throttled `ble-sighting` and
  `ble-status` frames back, folds sightings into the peer table (RSSI
  smoothing, cluster hysteresis, expiry), and calls
  `manager.connectLocalPeer` for same-project peers whose state hash
  differs (rate-limited per peer). This keeps discovery→sync working
  **with the main app process dead**. Core dedupes by connection
  `name` — synthetic `ble:<ip>:<port>` here — so a peer found via both
  mDNS and BLE can briefly hold two connections until core's
  post-handshake identity dedup reconciles them.
- **View** is the RPC surface (§4): `discovery.getState()` +
  `discovery-state` events on the services client. While the main
  process is dead nobody watches — but nothing stops either; the view
  rebuilds on the next foreground.
- **Resume**: the enabled flag + project persist to
  `<privateStorageDir>/ble-discovery.json`; the controller re-issues
  `ble-start` on every backend boot. FGS respawn, app cold start,
  device reboot into background sync — all self-heal with no
  main-process involvement.

## 5. Verification status

- JS: full Jest coverage (codec round-trips + byte-layout vectors,
  FIPS 180-4 / RFC 4231 hash vectors, discovery-manager lifecycle /
  smoothing / hysteresis / expiry with a fake native module); `tsc`
  strict + `noUncheckedIndexedAccess` clean; ESLint clean.
- Backend: `node --test` coverage of the codec mirror (shared
  cross-implementation vector with the TS suite) and the policy layer
  (relay, auto-connect decision matrix, per-peer throttle, missing
  manager, throwing `connectLocalPeer`).
- Kotlin: JVM tests for `BlePermissions`, `SightingThrottle`, and the
  new `ControlFrame` cases. The advertiser/scanner/engine and the FGS
  intent plumbing need on-device validation — emulators don't do BLE —
  which is exactly the proposal's open question Q1/Q8 (validate the
  advertisement with nRF Connect on Xiaomi/MIUI + MediaTek targets,
  concurrent advertise+scan stability, and background survival under
  aggressive OEM battery managers). That hardware pass is the next
  action for this branch.

## 6. Proposed: drop the Expo module — expose discovery over the existing RPC

**Status: implemented** (together with the §6c iOS foreground path).
The `ComapeoBleDiscoveryModule` Expo module described in earlier
revisions is gone.

With the radios in the FGS and the connect policy in the backend, the
Expo module is a bespoke side-channel that duplicates what the backend
already knows, exists only on Android, and re-implements (in JS) a peer
table the backend must keep anyway. The front end already has exactly
one interface to everything else this library does — the RPC clients —
so discovery should surface there too.

### What already reaches the front end today, with zero new surface

- **Connections**: `MapeoManager` emits `local-peers`
  (`PublicPeerInfo[]`: deviceId, name, `status: "connected" |
  "disconnected"`, connectedAt) and exposes `listLocalPeers()`; both
  reflect through `createComapeoCoreServer` → the `comapeo` client.
  A BLE-triggered `connectLocalPeer` lands here automatically.
- **Sync progress**: `project.$sync` state, as ever.

The only genuine gap is **pre-connection** state: nearby-but-not-
connected peers, the discovery machinery's status, and an on/off
control.

### The proposed surface (app-services RPC)

`backend/index.js` already serves an app-defined services object via
`createComapeoServicesServer` (today: `mapServer.getBaseUrl`). Extend
it — rpc-reflector reflects nested methods, and events on the served
object subscribe from the client via `.on(...)` (verified against
rpc-reflector's contract):

```ts
// via comapeoServicesClient
discovery.getState(): Promise<DiscoveryState>
discovery.setEnabled(enabled: boolean, opts?: { projectPublicId?: string }): Promise<void>
on("discovery-state", (state: DiscoveryState) => void)   // throttled snapshots

type DiscoveryState = {
  enabled: boolean;
  ble: {
    scanning: "active" | "stopped" | "unavailable";
    advertising: "active" | "stopped" | "unsupported" | "unavailable";
    /** Actionable — drives "Turn on Bluetooth" / permission-prompt UX. */
    blockers: Array<"bluetooth-off" | "permission-missing" | "no-adapter">;
  };
  peers: Array<{
    id: string;                     // "<ip>:<port>" or "ble:<mac>"
    sameProject: boolean;
    hasDifferentSyncState: boolean;
    rssi: number;
    inCluster: boolean;             // D7 clustering, computed backend-side
    lastSeenAt: number;             // backend clock
    address: string | null;
    port: number;
  }>;
};
```

Note the deliberate absence of identity on discovered peers: the
advertisement carries none (R3), so pre-handshake peers are anonymous.
"Nearby devices" (anonymous, counts, cluster UX) and "connected
devices" (`local-peers`, identified) are separate truths; the backend
drops a discovered peer from `peers` once it connects its ip:port.

`ComapeoServicesApi` is typed upstream in `@comapeo/ipc` — extend via
a local cast on both ends now, with an upstream PR to add the
`discovery` namespace (it is exactly the "app-provided services"
contract that type exists for).

### Consequences

- **The backend owns the whole lifecycle.** `setEnabled(true)` makes it
  start `startLocalPeerDiscoveryServer`, compose the advertisement
  itself ($sync state, project key → daily hash via `node:crypto`,
  `os.networkInterfaces()` for the IP) and command the FGS engine over
  the control socket. This deletes the §4a staleness caveat (the
  advertisement now tracks sync progress in the background) and
  follow-up 1a with it.
- **Resume hardens.** The enabled flag persists in `privateStorageDir`,
  so an FGS restart resumes discovery *without the main process* —
  closing the §4a resume gap the module's in-memory desired-state
  couldn't.
- **Control frames invert.** Node→FGS: `ble-start {payload}` /
  `ble-advertise {payload|null}` / `ble-stop`. FGS→Node:
  `ble-sighting`, `ble-error`, plus a new `ble-status` (scanning/
  advertising/blockers as observed by the engine — it, not JS, knows
  whether Bluetooth is off). Broadcast frames reach every control
  client, so the Kotlin parser gets no-op cases; on iOS the backend
  never sends them (`index.ios.js` gates the controller), keeping the
  Swift parser's unknown-frame `messageerror` path quiet until iOS
  support lands.
- **Deleted**: `ComapeoBleDiscoveryModule.kt`, the `BLE_*` intents and
  module registration, the `ble-peer` relay frame, and most of
  `src/ble/` — the JS peer table, the native-module wrapper, base64,
  and the pure-TS SHA-256/HMAC (its "must work without the backend"
  rationale dies with backend-side composition). What remains JS-side
  is types + the services-client extension. The wire format's
  normative home becomes the backend codec + this doc.
- **Permissions stay host-side, with no native module**: request
  `BLUETOOTH_SCAN` / `BLUETOOTH_ADVERTISE` / `BLUETOOTH_CONNECT` (API
  31+) or `ACCESS_FINE_LOCATION` (≤30) via React Native's own
  `PermissionsAndroid`; this package exports the permission-string
  constants. `blockers: ["permission-missing"]` tells the host *when*
  to prompt; after granting, `setEnabled(true)` again (or the backend
  retries on its next status poll). Manifest declarations already ship
  with the library.
- **Forward-compatible**: when the iOS scanner lands it feeds the same
  backend controller in-process, and the front-end surface doesn't
  change. The same is true for a future backend-side mDNS
  (`source: "mdns"` peers in the same list) — one "nearby devices"
  surface regardless of transport.

### Open questions

1. Multi-project advertisement selection (proposal Q2) becomes a
   backend decision — simplest: advertise the project named in
   `setEnabled` opts, defaulting to the device's only project.
2. Battery byte: stamp natively at advertise time (engine knows
   `BatteryManager`) vs. drop until Phase 3 election needs it.
3. Upstream `@comapeo/ipc` PR timing for the `discovery` namespace +
   the services-emitter event, vs. living with the local cast.

## 6b. Decision record: connect policy in Node, not Kotlin

Considered alternative: the Kotlin engine decodes advertisements,
compares hashes, and requests connections from Node over the control
socket ("connect to ip:port"), instead of forwarding sightings for Node
to decide. Rejected. The comparison:

- **The connection itself always happens in Node** — hyperswarm/Noise
  live there — so Kotlin-decides moves only the *decision*, not the
  work, and both variants die with Node. No autonomy is gained.
- **Decision inputs have data gravity in Node.** The decision needs the
  peer's decoded fields *and* our own current state: project keys (for
  the daily hash and its UTC-midnight rollover), live `$sync` state,
  the multi-project answer, the connect throttle. With backend-composed
  advertisements (§6) all of that originates in Node; Kotlin-decides
  would need Node to continuously push own-state down before decisions
  could be made against it.
- **Outcome visibility.** The decision loop wants feedback —
  `connectLocalPeer` exceptions, `local-peers` transitions for
  backoff/dedup. Node sees these in-process. The control socket is
  fire-and-forget frames, not RPC; Kotlin-decides is either blind to
  outcomes or forces request/response correlation onto the control
  protocol.
- **One policy implementation, not per-platform.** Kotlin-decides means
  re-implementing decode + policy in Swift for iOS (§6c) and shipping
  wire-format/policy changes in native lockstep on two platforms.
  Node-decides ships them in the backend bundle, tested with
  `node --test` and no device.
- **Latency is a wash** (one UDS hop either way), and **traffic is not
  actually saved** by Kotlin-decides: sightings must reach Node anyway
  to feed the `DiscoveryState.peers` view.
- **The honest cost of Node-decides is wakeups**: each forwarded
  sighting wakes the Node event loop (bounded by the native throttle to
  ~1 frame/s/peer, so ≤~30/s at target group size). If battery
  measurements demand it, the fix lives inside this architecture:
  batch sightings into one frame per interval, and/or lengthen the
  unchanged-payload interval when no main process is attached (the UI
  freshness it buys has no consumer in background) — payload *changes*
  still forward immediately, which is what the connect policy acts on.

Net: Kotlin (and later Swift) stays a dumb, replaceable radio driver;
policy stays where its inputs, its feedback, and its cheapest test
harness are.

## 6c. iOS path

**Status: foreground path implemented** (`ios/BleDiscoveryEngine.swift`
+ the Android `GattStateReader` read path; the wake-path options below
remain future work).

The architecture ports because everything above the radios is shared:
on iOS the backend runs in-process and the Swift side already speaks
the same control-socket protocol (`ControlFrame.swift` /
`NodeJSIPC.swift`), so an iOS engine slots in with **zero change to the
backend policy, the wire format, or the front-end RPC surface**.

What works, concretely:

- **iOS discovering Android (foreground)**: `CBCentralManager` scans
  and reads `kCBAdvDataManufacturerData` — CoreBluetooth cannot
  *filter* on manufacturer data, so the Swift engine scans broad (with
  `allowDuplicates` for the RSSI stream) and forwards only
  "CM"-prefixed payloads as the same `ble-sighting` frames. Software
  filtering costs battery vs Android's hardware offload; acceptable
  foreground-only.
- **Android discovering iOS**: iOS cannot advertise manufacturer data,
  but can advertise the CoMapeo **service UUID** (foreground) and host
  a GATT server (`CBPeripheralManager`) whose *Sync State
  characteristic value is the same 21-byte v1 payload* — one codec
  everywhere, resolving R4's circularity: D1 stays true for Android
  advertisements; iOS visibility comes from the UUID advert. The
  Android scanner gains a second `ScanFilter` (service UUID) and a
  small GATT-client read path that turns a characteristic read into
  the same `ble-sighting` frame.
- **Background reality**: iOS backgrounding freezes the embedded Node
  thread today, so iOS discovery is foreground-only *to match its
  sync reality* — not a new limitation. Two optional wake paths later:
  Android devices add a companion UUID-bearing advertisement (Android
  supports concurrent advertise sets) purely as an iOS background
  wake beacon (background CB scans require a UUID filter); and the
  `bluetooth-peripheral` background mode lets a backgrounded iPhone be
  briefly woken to serve its GATT state characteristic.
- **Never on iOS**: hotspot creation (Phase 3 leader role) and
  sustained background sync — as in the original proposal.

Plumbing when it lands: `Events`-style engine hooked to
`AppLifecycleDelegate` foreground transitions, `ble-*` no-op cases in
`ControlFrame.swift` (its unknown-type path currently surfaces
`messageerror`), `NSBluetoothAlwaysUsageDescription` via
`app.plugin.js`, and the backend's iOS entry (`index.ios.js`) stops
gating the discovery controller.

## 7. Follow-ups (rough order)

1. On-device validation (nRF Connect + two-device Android test;
   instrumented test for the module surface and the FGS engine,
   including background-sync: background both devices, add data on
   one via a debug seam, assert convergence).
1a. Backend-composed advertisements: derive `stateHash`/`totalBlocks`
   from `$sync` inside the backend so the advertisement stays fresh
   while the app is backgrounded (removes the §4a staleness caveat and
   the JS hash round-trip).
2. The R4 iOS design round → iOS scanner + GATT service definition;
   then the GATT server on both platforms (D4) and connectable
   advertisements.
3. Phase 2: scan-response with SSID hash + network-match UX (R6 caveats).
4. Phase 3: hotspot modules + leader election with an explicit
   dual-leader yield rule (R6), and the R5 credential-security decision.
5. SIG company ID registration before wide release (R6/D8).
