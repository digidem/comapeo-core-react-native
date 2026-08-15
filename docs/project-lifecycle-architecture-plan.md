# Project-instance lifecycle: architecture options & recommendation

> **Status: proposal.** Evaluates replacing `@comapeo/ipc` v9's client-visible
> project-instance lifecycle with a backend-owned lifecycle, so the React
> Native (and Electron) client never knows whether a project instance is open,
> closed, or has been replaced. Covers the option space, what the current
> design exists to protect, what a replacement must not regress, the e2e
> testing story, and a migration plan relative to the in-flight
> backend-restart-recovery PRs (#225/#226, comapeo-ipc#87, rpc-reflector#52).

## TL;DR

**Recommendation: Option 1 — backend-owned lifecycle over stable per-project
channels.** Key the per-project IPC channel by `projectPublicId` (stable
forever) instead of a per-open-lifetime instance id. The server (re)opens the
`MapeoProject` instance on demand, replays event subscriptions across re-opens,
closes instances itself on `leaveProject`, and rejects calls to left projects
with a synthesized error. The client's `getProject` becomes a cache-forever
lookup; `project.close()` disappears from the client surface; the entire
instance-id / revalidation / closed-proxy / tombstone / hard-close-on-restart
machinery is deleted. Backend restart recovery shrinks to two generic
transport-level operations (reject in-flight calls, resubscribe), with no
project-specific invalidation reaching the app layer.

This is a deliberate, informed return to the pre-v9 "re-open on demand" routing
— but with the three defects that killed it fixed (left-project resurrection,
lost server-side subscriptions, unroutable-error hangs). The insight that makes
it sound where the original was not: **every stale-reference hazard in the
current design traces back to `close()` being client-visible.** Remove
client-visible close, and "a stale call must not reach a re-opened instance"
stops being a correctness requirement — except for left projects, which get an
explicit guard.

For e2e testing, lifecycle control moves to a **test-only debug RPC channel**
registered by the e2e app's backend entry on the shared socket (under a
non-`@@comapeo/` prefix, which the production server already ignores by
design), plus the real triggers we already have (`leaveProject`, the Maestro
FGS-kill flow).

---

## 1. Where the complexity lives today

### 1.1 The v9 design in one paragraph

`createComapeoCoreServer` mints a per-open-lifetime **instance id**
(`@@comapeo/project/<projectId>:<counter>`) whenever a project is opened, and
returns it from `ProjectRoutingApi.assertProjectExists`. The client keys each
per-project `SubChannel` + rpc-reflector client on that instance id, caches
wrappers per project, **revalidates the cached wrapper's instance id over the
wire on every `getProject`** (comapeo-ipc#84), evicts on the `close` event
(#83), intercepts `close()` to tear down the local client, and swaps in a
closed-proxy that rejects (`ProjectClosedError` / `ClientClosedError`) after
close. The server keeps a tombstone set of closed instance ids and materialises
stub servers so stale calls get "Project is closed" instead of hanging.

### 1.2 The churn record

Project-close correctness has been reworked in **five** separate comapeo-ipc
PRs (#47, #49, #61, #74, #83/#84), and the backend-restart case is adding a
sixth layer across four repos:

- **rpc-reflector#52** (unpublished): `rejectPending` / `resubscribe` /
  `emitLocal`.
- **comapeo-ipc#87** (`feat/transport-reset`, unmerged): +190 lines of client
  transport-reset handling, `TransportClosedError`, and — critically —
  **hard-closing every cached project wrapper on restart**, because instance
  ids come from a process-local counter that a restarted server can remint, so
  the #84 revalidation check is *unsound across a restart* (documented in
  comapeo-ipc#87's own commit message).
- **This repo, #226** (`feat/rpc-transport-recovery`, draft): +997 lines,
  including a new public `subscribeToBackendRestart` API whose documented
  purpose is "any project client obtained via `getProject` before the restart
  is defunct and must be re-fetched".
- **comapeo-core-react#202**: a provider prop to plumb that restart signal into
  query-cache invalidation.
- Host-app fallout documented in #226's ARCHITECTURE.md §5.8: comapeo-mobile's
  module-scope captures (`useLocalPeers` first-client singleton, the local
  discovery controller's captured client, the cached map-server port promise)
  all hold dead project/client references after a restart and must be
  re-derived by hand.

Every item in that list below rpc-reflector#52 exists **because the client
holds references bound to a specific server-side instance lifetime**. That is
the tax the current architecture levies on every consumer, forever: each new
client-side cache of a project reference (a React hook, a module singleton, a
query cache) is a new restart-invalidation bug to find.

### 1.3 The defect that forced the v9 design (so we don't repeat it)

Pre-v9, per-project channels were keyed by `projectPublicId` and the server
opened projects on demand — superficially identical to what this doc proposes.
comapeo-ipc#61 replaced it because:

1. **Client-visible close was a lie.** `await project.close()` succeeded, then
   subsequent calls on the same reference silently re-opened a *brand-new*
   `MapeoProject` against the same storage. App code believed it had released
   a project while still writing to it. The e2e spec
   `create, close and then create, update`
   ([`apps/e2e/src/tests/project-crud.ts:228`](../apps/e2e/src/tests/project-crud.ts))
   pins the fix.
2. **A stale post-close call could reach a freshly re-opened instance** on the
   shared projectId-keyed channel — the race that motivated instance ids
   specifically.
3. **Open failures hung the client**: a failed `manager.getProject` tore down
   the channel and returned nothing, so callers waited out the RPC timeout
   instead of receiving `NotFoundError`.

Note what all three have in common: they are only defects **relative to a
client API that includes `close()`**. (3) is an error-plumbing bug, fixed
independently. (1) and (2) define "stale": a reference the client believes it
closed. If the client cannot close, references never go stale — with one
exception, leaving a project, which is handled explicitly below.

---

## 2. Constraints from `@comapeo/core` (v7.4.0)

These facts, verified against the pinned core sources, shape which options are
viable:

- **`manager.getProject` already implements re-open-on-demand.** It caches in
  `#activeProjects`, evicts on the project's `close` event, and constructs a
  fresh instance on the next call (`mapeo-manager.js:555-601`). A
  `MapeoProject` is strictly one-shot (`ready-resource` refuses open after
  close), so re-open always yields a genuinely different object.
- **The client cannot own lifecycle even in principle.** Core's fastify blob
  and icon plugins call `manager.getProject` per HTTP request
  (`mapeo-manager.js:269-279`) — every `<Image>` pointed at a blob URL opens
  projects behind the IPC layer's back. Any client-side refcount is wrong the
  moment media renders.
- **`leaveProject` is the case that forces backend ownership.**
  `manager.leaveProject` *opens* the project if needed, guts it
  (`kClearData`: closes non-auth datastores, purges cores, deletes indexes),
  and **leaves the gutted instance open and cached** (`mapeo-manager.js:1049-1051`).
  Core only cleans this up inside `addProject` on re-invite. Someone
  server-side must close that corpse; the client has no handle that can.
- **`getProject` on a left project does not throw.** It re-opens a
  live-but-empty instance (re-running `kClearData` defensively). "Left" is
  only visible via `listProjects({ includeLeft: true })` → `status: 'left'`.
  An IPC-level "you left this project" error must be synthesized.
- **Closing idle projects genuinely matters on mobile.** An open project
  replicates unconditionally against every connected peer from construction
  (`mapeo-project.js:497-526`), and `SyncApi` never idles below `presync`
  except via `kRequestFullStop` (backgrounding) or close. Plus each open
  project draws from one process-wide 768-fd `RandomAccessFilePool` budget and
  holds a `better-sqlite3` handle. So the architecture must leave room for a
  backend close policy — "never close anything" is not acceptable long-term.
- **rpc-reflector mechanics**: the channel is captured at `createClient`
  construction and cannot be swapped; server-side event subscriptions are a
  `Map` of listeners attached to the handler and are wiped by
  `server.close()` — they do **not** survive an instance swap. Client-side
  listeners are purely local state keyed by encoded event name, which is what
  makes `resubscribe` (rpc-reflector#52) possible: replay an `ON` frame per
  locally-listened event.

---

## 3. Options

### Option 0 — status quo + land the transport-reset stack (baseline)

Land rpc-reflector#52, comapeo-ipc#87, #225, #226, core-react#202 as designed.

- **Pros:** written, tested, reviewed; no re-architecture; #225's socket
  reconnect is needed under every option.
- **Cons:** the client-lifecycle tax from §1.2 becomes permanent, *growing*
  public API (`TransportClosedError`, `subscribeToBackendRestart`, four new
  ipc client functions) rather than shrinking it. Restart recovery relies on
  hard-closing wrappers because the instance-id scheme is unsound across
  restarts — pushing invalidation work into every host app indefinitely. The
  known host-app caveat list (§1.2) is the shape of every future bug report.

### Option 1 — backend-owned lifecycle over stable per-project channels ⭐ recommended

**Channel identity = project identity.** The per-project channel id becomes
`@@comapeo/project/<projectPublicId>`, stable across open/close cycles *and
across backend restarts*. No instance ids exist anywhere.

**Client side** (large net deletion):

- `getProject(projectId)` keeps its async signature and its existence check
  (one `assertProjectExists`-style round trip, now returning left/exists
  status rather than an instance id), then returns a wrapper cached **for the
  lifetime of the client**. No revalidation round-trip per call site, no
  eviction, no close interception, no closed proxies for projects, no
  `openProjectClients` registry sweep.
- `project.close()` is **removed from the reflected surface** (breaking, v10).
  The client has no lifecycle verbs at all.
- `ProjectClosedError` disappears; `ProjectLeftError` (new) and the existing
  `NotFoundError` from core are what callers see.
- After a backend restart, cached wrappers remain valid because their channel
  ids are stable. Recovery is only: reject in-flight calls
  (`createClient.rejectPending`) + replay subscriptions
  (`createClient.resubscribe`) on every channel. No wrapper hard-close, no
  `emitLocal`, no app-layer re-fetch requirement.

**Server side** — a per-project **host** that owns the open/close dance. On
the first message for a project channel (or an `ensureProject` routing call),
the routing layer:

1. Serializes per project (keep today's in-flight-promise dedupe — it is
   load-bearing against core's close-in-flight window, where `getProject`
   still returns the dying instance until `close` fires).
2. Checks left status via `listProjects({ includeLeft: true })` (or the
   project-keys row); **left → reject `ProjectLeftError`**, never re-open.
   This is the guard that prevents the pre-v9 "resurrect a left project"
   failure.
3. Otherwise `manager.getProject(projectId)` (which re-opens if needed), binds
   a fresh rpc-reflector server for the instance on the stable channel, and
   **replays the project's recorded subscription state** into it.
4. Subscribes `once('close')` on the instance to tear the rpc server down and
   mark the host "dormant" — *not* tombstoned. The next message re-runs this
   sequence.

Two implementation variants for subscription persistence:

- **1a. Subscription tape (recommended).** The routing layer snoops the
  per-project channel for rpc-reflector `ON`/`OFF` frames and keeps a
  per-project set of `(eventName, propArray)` subscriptions. On re-open it
  replays `ON` frames into the new server (synthesized message events on the
  channel). Messages that arrive while an open is in flight are buffered by
  the host and dispatched after the server is bound — which also fixes the
  ordering hazard where a write triggers a re-open but the `ON` replay must
  land first. Couples the ipc package to rpc-reflector's wire frames, which is
  acceptable: same maintainer, already coupled via `MessagePortLike` and error
  types, and the frame format (`[ON, eventName, propArray]`) is tiny and
  stable.
- **1b. Long-lived facade.** Bind one rpc-reflector server per project to a
  permanent facade object (rooted in a real `EventEmitter` to satisfy
  `getNestedEventEmitter`'s `instanceof` check) that delegates each method
  call through `ensureOpen()` and re-attaches event forwarders from the
  current instance on re-open. No wire-frame coupling, but fiddlier: every
  emitter-bearing nested path (`$sync`, datatypes, …) needs a live emitter
  facade, and the delegation proxy has to satisfy rpc-reflector's
  `Reflect.has` walks. More code, more `MapeoProject`-shape knowledge baked
  into ipc. Prefer 1a; keep 1b in reserve if frame-snooping proves brittle.

**Lifecycle policy lives in the backend, as policy, not protocol:**

- **On `leaveProject`:** the server observes manager `leaveProject` calls (an
  `onRequestHook`, or a thin wrapper on the manager handler) and closes the
  gutted instance immediately after the call resolves. Core will not do this
  itself (§2).
- **On idle (later, optional):** close instances with no RPC traffic, no media
  requests, and no data-sync interest for N minutes. Transparent to clients by
  construction — the next call re-opens. This is where the fd/sync pressure
  from §2 gets solved *without any protocol change*, which is exactly the
  point of backend ownership. Not needed for v1; `onBackgrounded`'s full-stop
  already covers the worst case.
- **On shutdown:** unchanged (`manager.close()` closes all).

**Semantics after the change:**

| Situation | v9 behaviour | Option 1 behaviour |
|---|---|---|
| Call on project after backend closed it (resource policy) | `ProjectClosedError` forever on old ref; must re-`getProject` | Transparent re-open; call succeeds |
| Call on project after `leaveProject` | `ProjectClosedError` (via close event / revalidation races, #83/#84) | `ProjectLeftError`, deterministically, from the left-guard |
| Call after re-invite (`addProject` closes stale gutted instance) | Old ref dead, new ref needed | Transparent: host re-opens the re-added project on the same channel |
| Backend restart | All wrappers hard-closed; app must re-fetch everything | Wrappers survive; in-flight calls reject `TransportClosedError`; subscriptions replayed |
| `getProject` on unknown project | `NotFoundError` | `NotFoundError` (unchanged) |
| Events across a backend-initiated close | Lost with the old wrapper | Replayed subscriptions on re-open; no events are *generated* while closed (closed ⇒ not syncing), so nothing is silently missed |

**What must not regress (from the v9 archaeology) → how Option 1 answers:**

1. *Stale ref must never reach a re-opened project* → reframed: with no client
   `close()`, "stale" only means "left", and the left-guard rejects before
   open. The instance-id remint flaw disappears with instance ids.
2. *Server closes without the client asking* → the design's core case, not an
   edge.
3. *Zero retained instances across open/close cycles* (the `--expose-gc`
   WeakRef test asserting 0 survivors) → hosts hold no instance reference
   while dormant; forwarders/servers detach on `close`. Keep the WeakRef test
   verbatim.
4. *Server-side subscriptions die with the per-instance server* → the tape
   replays them; restart recovery still uses client `resubscribe`.
5. *Unsubscribe on dead references must be a no-op* (comapeo-ipc#87 follow-up
   commit) → adopt; mostly moot since project refs no longer die.
6. *Open failures must surface as errors, not hangs* → the routing round trip
   in `getProject` plus per-call rejection from the host's ensure-open path.

**Costs / risks:**

- Breaking v10 for both consumers (this repo and comapeo-desktop) — but the
  surface change is small: `project.close()` gone, `ProjectClosedError` gone,
  `ProjectLeftError` added. Notably **no production code in this repo calls
  `project.close()` today — only the e2e suite does** (§4).
- The host/tape machinery is new server-side code (~200–300 lines replacing
  ~similar amount of tombstone/stub/routing code; the big deletion is
  client-side).
- Ordering subtleties concentrate in the host (buffer-during-open, replay
  before dispatch, serialize with the close-in-flight window, `once('close')`
  not `on` — core double-emits `close`). All unit-testable against the
  existing fake manager, which already models core's cache/evict/re-open
  behaviour.

### Option 2 — keep the instance model, fix its restart soundness

Minimal repair: mint a per-server-boot nonce into instance ids so remint
collisions cannot false-validate, land the transport-reset stack, keep
everything else.

- **Pros:** smallest diff from today; no breaking change.
- **Cons:** pure hardening of the tax base — every §1.2 cost stays, the
  restart path still hard-closes wrappers (now correctly), apps still must
  re-fetch on restart, and the five-PR churn pattern continues. Choose this
  only if Option 1 is rejected on schedule grounds.

### Option 3 — flatten to projectId-parameterized RPC (no per-project channels)

Replace project objects with `callProjectMethod(projectId, path, args)` on the
manager channel and synthesize typed wrappers client-side; events become a
`(projectId, eventName)` subscription protocol.

- **Pros:** channels and instance identity vanish entirely.
- **Cons:** reimplements rpc-reflector's method/event reflection by hand on
  both ends, discards working, tested machinery, and still needs every
  backend-ownership decision from Option 1 (left-guard, close policy). All of
  the cost, none of the leverage. **Rejected.**

### Option 4 — upstream lifecycle ownership into `@comapeo/core` (long-term)

Teach core's `MapeoManager` to hand out stable project *facades* itself (and a
real project-opened event — today's only signal is this repo's
`sync-observer.js` monkey-patch on `getProject`). Then ipc reflects a surface
that is already lifecycle-free, and desktop/cloud get the same fix for free.

- **Pros:** the architecturally "right home"; deletes the ipc host layer too.
- **Cons:** cross-repo, slower, core-team scope; `addProject`'s own TODOs show
  upstream knows the area is warty. **Not the vehicle for this fix, but
  Option 1's host is a working prototype of exactly this API — propose it
  upstream once proven.**

---

## 4. The e2e testing story

Today only `apps/e2e/src/tests/project-crud.ts` touches lifecycle, in three
ways — each has a clean answer under Option 1:

1. **Contract pins on removed semantics** (`create, close and then create,
   update` asserting post-close rejection; `close, re-open, read` asserting
   revalidation). These tests pin the v9 contract and are **replaced, not
   ported**: the new contract tests are "calls succeed transparently after a
   *backend-initiated* close" and "calls reject `ProjectLeftError` after
   `leaveProject`".
2. **Causing a backend-side close in a test.** Three mechanisms, in order of
   preference:
   - **Real triggers:** `comapeo.leaveProject(id)` (real API, tests the
     left-guard); the Maestro FGS force-stop flow (`fgs-restart.yaml`) for the
     restart path — extend it to run an RPC + event round-trip across the
     restart, which today it doesn't.
   - **Test-only debug channel:** the e2e app's backend entry (this repo owns
     `backend/index.js`; the e2e bundle can register extras) exposes a tiny
     rpc-reflector server on the **shared** socket under a non-`@@comapeo/`
     channel id (e.g. `@@comapeo-debug/lifecycle`) with
     `closeProject(projectId)` / `listOpenProjects()`. The production server
     drops foreign-prefix traffic silently by design, and the RN test suite
     reaches it via the existing `unstable_messagePort` escape hatch +
     `createClient`. Zero production API surface, deterministic, and it
     directly exercises the transparent-re-open path.
   - **Config knob:** if/when the idle-close policy lands, the e2e backend
     sets an aggressively short timeout, turning idle-close into a passively
     tested path.
3. **The `afterEach` close-for-listener-hygiene** ("otherwise
   MaxListenersExceeded fires"). Under stable wrappers the leak vector
   (accumulating channels/wrappers per test) is gone; hygiene becomes plain
   `removeListener`/`removeAllListeners` in `afterEach`, which per the
   comapeo-ipc#87 follow-up should be (and will be) safe no-ops on any dead
   reference.

comapeo-ipc's own suite: `tests/project-close.js` becomes
`tests/project-reopen.js` (transparent re-open, left-guard, buffer-during-open
ordering, subscription replay, WeakRef zero-retention — the fake manager
already models everything needed); `tests/transport-reset.js` from #87 slims to
reject-pending + resubscribe with **no** wrapper hard-close cases.

---

## 5. Migration plan & relationship to in-flight work

Phased so that each step ships value even if the next slips:

1. **Land #225 now** (Android socket reconnect). Transport-level; required
   under every option; no lifecycle coupling.
2. **rpc-reflector#52: land `rejectPending` + `resubscribe`; drop
   `emitLocal`.** `emitLocal` exists only to fire `close` on hard-closed
   wrappers — Option 1 has neither. (If #52 ships first with `emitLocal`,
   it's harmless dead weight.)
3. **comapeo-ipc v10 (the redesign, ~one PR):** stable channels + server-side
   host with subscription tape + left-guard + `leaveProject` close hook;
   delete instance routing, tombstones, closed proxies, close interception,
   revalidation; keep `TransportClosedError` and slim the #87 branch's
   notify/resubscribe pair into `notifyTransportReset(client)` (reject
   in-flight, generic) + `resubscribe(client)` (replay, generic). Rewrite the
   lifecycle tests per §4. Supersedes #87 — salvage its tests and its
   split-reset-from-resubscribe insight (resubscribing into a down transport
   hot-loops the native reconnect).
4. **This repo:** adopt v10; #226 shrinks to wiring the two generic calls to
   the existing `transportStateChange` native event (the +99-line
   `ComapeoCoreModule.ts` recovery block roughly halves; the ordering-matrix
   unit tests mostly survive). `subscribeToBackendRestart` becomes optional —
   keep it as a *data-freshness* hint ("events emitted while the transport was
   down are lost; refresh queries"), which is a far weaker contract than
   "every project reference you hold is dead". Rewrite
   `project-crud.ts` lifecycle specs + add the debug lifecycle channel to the
   e2e backend entry; extend `fgs-restart.yaml` with a cross-restart RPC
   round-trip.
5. **comapeo-desktop:** adopt v10 (same win — its utility process restarts
   independently of renderers too). Coordinate the release train:
   rpc-reflector → comapeo-ipc v10 → consumers.
6. **Later:** idle-close policy in the backend (pure policy change, no
   protocol impact — the payoff of backend ownership); propose the host/facade
   API upstream to core (Option 4).

## 6. Open questions

- **`ProjectLeftError` vs `NotFoundError` for left projects:** core's
  `listProjects` hides left projects by default, so "not found" is arguably
  consistent — but a distinct code is more debuggable and costs nothing.
  Proposed: new `ProjectLeftError` (`code: 'PROJECT_LEFT'`).
- **Should `getProject` keep its existence round-trip?** Keeping it preserves
  DX (`getProject` of a bad id rejects at the call site, matching the pinned
  `Attempting to get non-existent project fails` test) at one RTT per
  projectId per app session. Proposed: keep.
- **Left-status check freshness:** the host caches "left" per project and must
  invalidate on `addProject` (re-invite). Simplest correct version: re-check
  on every dormant→open transition only (left projects stay dormant, so each
  attempt re-checks; open projects can't be left without a close landing
  first, because `leaveProject` triggers the close hook).
- **Does any consumer rely on the project `close` *event* as an app-level
  signal?** In this repo, no (only the ipc-internal eviction listener). Needs
  a check in comapeo-desktop/core-react before deleting from the surface;
  a manager-level `project-left` notification could replace it if so.
