# JS runtime alternatives to `nodejs-mobile`

Research notes and assessment of options for replacing `nodejs-mobile` as
the backend JS runtime in `comapeo-core-react-native`. Decision horizon:
1–2 years. Workload to run: `fastify` HTTP + `@comapeo/core` (hypercore
family) + SQLite (currently `better-sqlite3` + drizzle) + crypto
(`sodium-native`) + P2P networking (`udx-native`) on a background thread
separate from React Native's UI.

Companion docs: [build-architecture-plan.md](./build-architecture-plan.md)
and [bare-architecture.md](./bare-architecture.md).

---

## 1. TL;DR

1. **Stay on `nodejs-mobile` for the near term.** None of the alternatives
   is a drop-in replacement; all require significant work; each has a
   specific blocker that is not solvable without per-option rewrites.
2. **The two credible migration targets are Bare (1–2 year horizon) and
   Hermes + Node-API-on-Hermes (2–3 year horizon).** Everything else
   (Deno, QuickJS/LLRT, Socket Runtime, Tauri mobile, Rust/Go rewrites,
   WebView) is either not mobile-embeddable, not Node-compatible, or
   requires rewriting the backend in a different language.
3. **The universal blocker across every JS-runtime alternative is
   `better-sqlite3` + drizzle's sync API.** Addressing this — either by
   picking a SQLite driver all candidates can support, or by replacing
   drizzle's SQLite dialect — is prerequisite work that has to happen
   before *any* migration regardless of destination.
4. **`hermes-node` (as described in the Mikov tweet) is not a realistic
   target for a 1–2 year plan.** Source isn't public as of April 2026;
   no Meta organizational commitment; scope is enormous. Re-evaluate in
   12 months once source lands.
5. **Static Hermes is already landing** — Hermes V1 is the default in
   RN 0.84 (Feb 2026), folding much of the Static Hermes research into
   shipped code. The AOT-to-native piece is still research-only. This
   is good news for the UI side but doesn't change the backend picture.

---

## 2. Decision matrix

Qualitative scoring on a 1–5 scale (5 = best). Estimates; not precise.

| Option                                 | Drop-in-ness | Perf   | Size   | Maint. cost | Future-proof | Native-dep risk |
|----------------------------------------|--------------|--------|--------|-------------|--------------|------------------|
| `nodejs-mobile` (today)                | 5            | 3      | 1      | 2           | 2            | 5                |
| Bare + bare-kit                        | 2            | 4      | 4      | 3           | 3            | 2                |
| Second Hermes VM + JSI shims           | 1            | 2*     | 5      | 1           | 4            | 3                |
| Hermes + `react-native-node-api`       | 3            | 2*     | 5      | 2           | 3            | 4                |
| `hermes-node` (future)                 | 4 (claimed)  | ?      | ?      | ?           | 4            | ?                |
| QuickJS / primjs / LLRT                | 1            | 3      | 5      | 1           | 2            | 1                |
| Rust rewrite (UniFFI)                  | 0            | 5      | 4      | 3           | 5            | 5                |
| Socket Runtime                         | 1            | ?      | 3      | 2           | 2            | 1                |

`Drop-in-ness`: how much of the current backend code and npm ecosystem works
without changes. `Perf`: expected runtime speed on data-heavy (crypto,
streams) workloads. `Size`: per-ABI binary footprint (higher is smaller).
`Maint. cost`: expected eng-hrs/year to keep current, relative to other
options (higher is less). `Future-proof`: likelihood this option is still
supported in 3+ years.

`*` Hermes scores 2 on perf specifically because of
[facebook/hermes#569](https://github.com/facebook/hermes/issues/569):
hypercore's JS-side hashing (rotr64, sha-256 kernels) is reported
~15× slower than JSC. Native sodium bypasses this for most crypto, but
any JS-side bit-twiddling pays the cost.

---

## 3. Cross-cutting blockers (apply to any migration)

### 3.1 `better-sqlite3` and drizzle

- `better-sqlite3` is a synchronous Node-API addon. The only runtime that
  supports its exact API surface is Node itself (or nodejs-mobile).
- **Bare:** Holepunch's `sqlite3-native` exists but has a different
  async API. Drizzle's better-sqlite3 driver won't work as-is.
- **Hermes + Node-API-on-Hermes:** *theoretically* could recompile
  better-sqlite3 against the Hermes N-API ABI, but no-one has done it
  and `react-native-node-api` is unmerged upstream.
- **All other options:** require async SQLite (op-sqlite, nitro-sqlite,
  WA-SQLite, `@libsql/core`, etc.) which in turn require drizzle to use
  an async driver.
- **Mitigation**: pick an async SQLite driver that works on all
  candidate runtimes, migrate drizzle to it, verify migrations + app
  behaviour under sync-free access patterns. This is prerequisite to
  *any* non-nodejs-mobile path. Worth doing regardless of final
  destination — estimated 2–4 weeks.

### 3.2 `fastify`

- Fastify is a pure-JS dep and so portability depends on its Node-core
  dep set: `net`, `tls`, `http`, `stream`, `events`, `buffer`, `path`,
  `url`, `crypto`, plus its own internal deps (`find-my-way`, `pino`,
  `avvio`, `@fastify/ajv-compiler`).
- **Bare:** `bare-http1` exists but fastify compatibility is unverified
  and not a documented use case. `bare-https` and `bare-tls` similarly
  unverified.
- **Hermes:** need the entire Node HTTP/streams stack reimplemented.
- **QuickJS / LLRT:** LLRT has partial HTTP (fetch-like) but no Node
  `http.Server` semantics. Fastify won't run.
- **Mitigation**: decide whether HTTP is load-bearing. If it's only used
  for local IPC with the RN UI (unlikely — we already use UDS) or for
  exposing a local HTTP API to mobile browsers, **replace fastify with
  a smaller, more portable server** (e.g. a minimal router on
  `bare-http1` or a pure-JS server on whatever the target provides).
  1–2 weeks.

### 3.3 The hypercore stack

- Hypercore and its deps assume `sodium-native`, `udx-native`,
  `fs-native-extensions`, `simdle-native`, `rabin-native`.
- Only Holepunch has ported these to non-Node runtimes: Bare is a
  first-class target (all five listed as Bare-native). Nothing else is.
- `sodium-javascript`, `libsodium.js` exist but are incomplete
  (tweetnacl-subset) or async-only (WASM). Hypercore-crypto's fallbacks
  aren't complete (see
  [holepunchto/hypercore#234](https://github.com/holepunchto/hypercore/issues/234)).
- `udx-native` has no pure-JS or WASM equivalent. A reliable,
  multiplexed, congestion-controlled UDP stream stack is not trivial to
  reimplement.
- **Mitigation:** essentially none. If the runtime doesn't run hypercore
  natively (Bare: yes; Hermes + Node-API: maybe with recompile; anything
  else: no), this is a multi-engineer-year problem. This is the biggest
  reason **Bare is the leading migration candidate despite its
  ecosystem gaps** — five of the six native deps are already ported.

---

## 4. Per-option assessments

### 4.1 `nodejs-mobile` (status quo)

**Real cost we're already paying:**

- Per-ABI binary: ~50 MB. Three Android ABIs = ~150 MB of native code
  before any JS. AAB splits help users, not dev artifacts.
- Stuck on Node v18 as of April 2026. Maintenance is slow —
  nodejs-mobile has limited active maintainers, and every Node major
  requires re-patching V8 for mobile. Security updates lag.
- Our build pipeline (per-module prebuild repos + shared workflow) has
  real operational burden but is in good shape; see
  [build-architecture-plan.md](./build-architecture-plan.md).

**Why it's still the right default:**

- Actually-works today for every backend dep we ship.
- Drizzle + better-sqlite3 + fastify + hypercore all run unmodified.
- iOS signing and Android packaging are solved (after the pending
  migration to `jniLibs`/xcframework packaging).

**When to reconsider:**

- If Node 18 EOL (reached April 2025 for regular, April 2025 extended)
  pushes a CVE we can't patch.
- If nodejs-mobile itself goes unmaintained (watchable; currently still
  has occasional commits).
- If app size becomes a distribution problem we can't solve through
  ABI splits.

### 4.2 Bare + `bare-kit`

**Strengths:**

- Five of six native deps are Bare-native (`sodium-native`,
  `udx-native`, `simdle-native`, `fs-native-extensions`, `rabin-native`).
  The hypercore stack is Holepunch's primary use case.
- Smaller binary — one HN data point claims 45 MB → 35 MB vs
  nodejs-mobile, unverified per-arch. Release tarballs are multi-arch
  and large (~100 MB), but deliverable size per-app is smaller.
- Engine flexibility: V8 by default, JavaScriptCore (`libjsc`) alternative
  avoids iOS `allow-jit` entitlement, QuickJS (`libqjs`) as fallback.
- Active weekly releases; Holepunch has clear commitment.

**Weaknesses:**

- **`better-sqlite3` has no Bare equivalent** with the same API.
  `sqlite3-native` has different async shape; drizzle's better-sqlite3
  driver breaks. Must migrate drizzle to an async dialect first.
- **`fastify` compatibility unverified** and probably requires
  replacement — the ecosystem is fastify → pino → avvio → N deps and
  they all need to compose on top of `bare-http1`.
- **Maintainer concentration**: 7 contributors on bare; 1485 commits
  from Kasper Isager; everyone else <10. Bus factor is 1–2.
- `react-native-bare-kit` is pre-1.0 (v0.13.x) and sees occasional
  regressions on RN/Xcode bumps.
- Non-Holepunch adoption is thin — Tether WDK and a handful of wallet
  apps. Not Shopify-scale production.

**Estimated effort:**

- One-time migration: 3–6 engineer-months. Biggest chunks are
  async-sqlite + fastify replacement. `@comapeo/core` itself likely
  ports cleanly because Holepunch owns the stack.
- Ongoing: 100–200 eng-hrs/year to track Bare releases, RN bumps, and
  build regressions.

**Verdict:** the strongest migration candidate, but only viable after
the async-SQLite groundwork is done. Likely a 2027 discussion.

### 4.3 Second Hermes VM (JSI worklet backend)

**Architecturally possible today**: `react-native-worklets-core`
(Margelo) and `react-native-worklets` (Software Mansion) both spawn
independent Hermes VM instances in the same process, each with its own
heap and event loop.

**But:** worklets are designed for *function* offload, not for hosting
a general-purpose JS runtime. They require a `'worklet'` directive and
Babel-transpile closures. Loading arbitrary npm packages that do
`require('net')` at module scope will not work out of the box.

**The real problem is the JS half.** Hermes ships no Node core:

- Need shims for `fs`, `net`, `tls`, `http`, `stream`, `events`,
  `buffer`, `path`, `url`, `crypto`, `querystring`. Some (`buffer`,
  `events`, `stream`, `path`, `querystring`) come from npm packages
  that work unmodified. The rest need JSI-backed implementations.
- For `net`: `react-native-tcp-socket` is TCP-only — no Unix domain
  sockets. Unix-domain IPC on Android/iOS would be new JSI native code.
- For `fs`: `react-native-fs` / `expo-file-system` are main-thread
  oriented. JSI bindings install on a single `jsi::Runtime&`, which is
  per-VM — you'd need to re-install each JSI module on the worker
  runtime. Possible but not out-of-the-box.
- For `http`: fastify depends on Node `http.Server`; you need the full
  HTTP/1.1 parse + connection lifecycle on your `net` shim.

**The native-module problem:** standard Node-API addons don't load on
Hermes. Solutions are either:

1. JSI alternatives (op-sqlite for SQLite, react-native-sodium-jsi for
   crypto, react-native-quick-crypto) — none cover udx/hypercore.
2. **`react-native-node-api`** (Callstack, v1.0.1 Jan 2026) — adds
   Node-API to Hermes. This is the interesting development. It would
   let us recompile `sodium-native`, `better-sqlite3`, `udx-native`
   against Hermes's N-API headers.
3. Custom JSI bindings for each native dep. Weeks per module.

**Caveats on `react-native-node-api`:**

- Built against a patched Hermes fork, pinned to RN 0.79.1/0.79.2.
- Upstream Hermes PR unmerged; Meta has stated they have "no internal
  usages" of Node-API and **will not maintain it**
  ([facebook/hermes#1074](https://github.com/facebook/hermes/discussions/1074)).
- Production-readiness for complex addons (threadpool, libuv internals)
  unproven.

**Hermes performance for server workload:**

- [facebook/hermes#569](https://github.com/facebook/hermes/issues/569):
  `rotr64` 15ms on Hermes vs <1ms on JSC. ethers.js mnemonic import
  ~15s on Hermes. Relevant for hypercore's JS-side hashing.
- Native sodium calls bypass this for the heavy crypto, but any JS-side
  bit-twiddling pays a tax.
- Long-running Hermes (multi-hour server role) — no public data. Hades
  GC is tuned for UI cadence.

**Estimated effort:**

- One-time: 9–18 engineer-months for a "fastify-capable + hypercore"
  compat layer on a second Hermes VM, with native deps ported via
  `react-native-node-api`. Could be substantially less if we drop
  fastify and take a smaller HTTP server, and if `react-native-node-api`
  lands upstream.
- Ongoing: **ever-growing** unless backend dep set is frozen. Every new
  transitive dep risks requiring a new JSI shim.

**Verdict:** the most architecturally interesting option but the riskiest.
Requires betting on `react-native-node-api` surviving without upstream
Hermes support. 2027–2028 candidate, not earlier.

### 4.4 Hermes-node (Mikov)

**What we know (April 2026):**

- Source not public. Only signal is Mikov's tweet about it existing.
- Claimed scope: fs, net, http, child_process ports via Node-API;
  reuses Node's actual `lib/*.js` files; vendors libuv, c-ares, llhttp.
- Self-described "work in progress"; tone is solo-research-project.
- No Meta blog post, no RN blog mention, no roadmap commitment.

**If it exists and works as claimed**, it would be the cleanest
migration target — same runtime (Hermes) as the RN UI, Node-API native
addons, Node's own JS lib. But that's several "ifs."

**Risk assessment:**

- Scope is gigantic. Node's fs + net + http + streams + TLS + crypto +
  ESM + worker_threads is larger than any single contributor typically
  sustains on a 12–24 month horizon.
- No funding signal; no Meta org commitment visible.
- Realistic: **3+ years** before a credible nodejs-mobile replacement.

**Verdict:** keep watching. Revisit in 6–12 months when (if) a public
repo appears. Not a migration target today.

### 4.5 QuickJS / QuickJS-NG / primjs / LLRT

All are legitimately small (<1 MB engine), fast to start, and
production-grade as *engines*. None is a Node replacement:

- **QuickJS-NG**: actively maintained, mobile-embeddable (see
  `bojie-liu/react-native-quickjs`). Claimed ~15% faster than JSC on
  iOS with code caching. No Node-core APIs.
- **primjs (ByteDance/Lynx)**: ~210 KB, proper GC instead of refcount,
  template interpreter, ships in TikTok. Zero Node compat.
- **LLRT (AWS Lambda)**: partial Node API (buffer/stream/fetch full;
  fs/http partial; no native addon support). Explicitly not for mobile.

**Verdict:** not viable for our workload. Zero Node-API compatibility means
rewriting the hypercore stack + crypto + SQLite against a new API.
Engineering cost approaches a full rewrite — at which point the Rust/Go
option below is more attractive because at least the binary is faster.

### 4.6 Rust rewrite via UniFFI

- Mozilla + Filament released `uniffi-bindgen-react-native` Dec 2024.
  Generates RN Turbo Modules from Rust. The bridging tech is mature.
- The ecosystem is immature: **no production-quality Rust port of
  hypercore exists.** Partial/abandoned efforts (`hypercore-rust` etc.)
  don't reach feature parity.
- `libsodium` has excellent Rust bindings (`sodiumoxide`, `libsodium-sys`).
- `rusqlite` is production-grade and the dominant Rust SQLite binding —
  solves the better-sqlite3 problem outright.
- Effort estimate: **1–2 engineer-years to rewrite @comapeo/core in
  Rust**, plus ongoing sync with upstream hypercore releases (if any).

**Verdict:** viable long-term escape hatch if the JS ecosystem story
becomes untenable; wildly impractical on a 1–2 year horizon. Record for
future reference.

### 4.7 Socket Runtime

Cross-platform P2P-focused runtime (iOS/Android/desktop) with its own
native APIs (UDP, Bluetooth, FS, crypto) and a WebView JS context.
Philosophically the closest match to what we want — built specifically
for local-first P2P apps.

**Why not:**

- Not Node — you'd rewrite `@comapeo/core` against Socket's APIs.
- It's a WebView runtime, not a separate VM; integration with RN is not
  the sweet spot. You'd pick Socket *instead of* RN.
- Beta-ish; no clear path for "add Socket as a subsystem inside an RN
  app."

**Verdict:** interesting parallel universe; not a migration target for
this app.

### 4.8 Options we ruled out quickly

- **Deno / deno_core / rusty_v8 on mobile** — Android support shipped
  and was removed; iOS never landed. You'd be the one making it work.
- **Bun on mobile** — no embedding API, no mobile port.
- **Node on WASM/WASI** — no official Node-on-WASI build; would require
  porting Node+V8 to WASM first. Research-grade.
- **GraalJS on Android** — depends on `sun.misc.Unsafe`, not available
  on Android
  ([oracle/graaljs#514](https://github.com/oracle/graaljs/issues/514)).
- **Tauri mobile + Node sidecar** — sidecar binaries unsupported on
  mobile
  ([tauri-apps/tauri#11454](https://github.com/orgs/tauri-apps/discussions/11454)).
- **Node as a packaged native binary on iOS** — iOS requires dynamic
  libs to live in `/Frameworks`, signed with app identity. Arbitrary
  forked processes are disallowed.

---

## 5. Decision framework

### Stay on `nodejs-mobile` if:

- We have 1–2 years of runway where binary size and Node 18 EOL are not
  forcing a migration.
- Our engineering capacity is better spent on product features than on
  runtime migration.
- We can get by with the build-pipeline improvements in
  [build-architecture-plan.md](./build-architecture-plan.md) — which
  solve the *packaging* pain without touching the runtime.

### Migrate to Bare if:

- `nodejs-mobile` binary size becomes a distribution blocker we can't
  solve through AAB splits.
- We're willing to do the async-SQLite + fastify-replacement work
  (4–6 weeks prerequisite).
- We're OK betting on a runtime with a small maintainer community.
- Timing: 2027 at earliest.

### Pursue Hermes + `react-native-node-api` if:

- The ecosystem signals shift — upstream Hermes merges Node-API
  support, or a Meta-backed hermes-node gets a public repo with real
  contributors.
- We accept 9–18 months of shim-layer engineering.
- Timing: 2027–2028.

### Rewrite in Rust if:

- All JS-runtime options stop being viable (nodejs-mobile dies, Bare
  dies, Hermes doesn't deliver).
- We accept 1–2 engineer-years as the migration cost.
- Timing: 2028+ or never.

### Options to monitor without acting on:

- `hermes-node` (source publication, contributor count, Meta backing).
- Bare ecosystem scale (number of non-Holepunch production apps).
- Upstream Hermes Node-API acceptance.
- `@comapeo/core`'s own runtime support (Holepunch might target Bare
  natively, which would change the calculus significantly — watch
  hypercore's own target list).

---

## 6. Recommended near-term actions

None of these commit to a migration. They all reduce risk and prep for
any of the above paths:

1. **Ship the `nodejs-mobile` build-pipeline improvements** from
   [build-architecture-plan.md](./build-architecture-plan.md). Reduces
   current ops burden regardless of long-term path.
2. **Audit fastify usage.** Does the backend actually need a general HTTP
   server, or is everything IPC over UDS now? If fastify is vestigial,
   remove it — eliminates one major portability blocker.
3. **Prototype an async-SQLite migration of drizzle** in a branch. Pick a
   driver that works on multiple candidate runtimes (op-sqlite on
   Hermes; sqlite3-native on Bare). Don't ship yet; establish the
   migration shape and cost.
4. **Extract `node:net` usage into a single `socket-transport.js`**
   (already proposed as phase 4 in the build-architecture plan).
   Trivial change, keeps the door open for Bare or a JSI shim.
5. **Keep a quarterly review cadence** for this doc. Re-check
   hermes-node, bare ecosystem growth, Node-API-on-Hermes status,
   Hermes V1 performance on data-heavy workloads, and the
   `@comapeo/core` target list. Update the verdicts as evidence changes.
6. **Do not invest in prototyping any migration yet.** The prerequisite
   work in (1)–(4) pays off on any path. Jumping to a migration before
   doing them means doing the same work twice.

---

## 7. Sources

All primary-source-verified findings are from research agents run
April 2026. Key references:

**Bare:**
- [holepunchto/bare](https://github.com/holepunchto/bare),
  [bare-kit](https://github.com/holepunchto/bare-kit),
  [react-native-bare-kit](https://github.com/holepunchto/react-native-bare-kit),
  [bare-node](https://github.com/holepunchto/bare-node),
  [sqlite3-native](https://github.com/holepunchto/sqlite3-native)
- [Tether WDK React Native quickstart](https://docs.wdk.tether.io/start-building/react-native-quickstart)

**Hermes + Node-API:**
- [callstackincubator/react-native-node-api](https://github.com/callstackincubator/react-native-node-api)
- [Callstack: Announcing Node-API for React Native](https://www.callstack.com/blog/announcing-node-api-support-for-react-native)
- [facebook/hermes#1074 — Node-API discussion](https://github.com/facebook/hermes/discussions/1074)
- [facebook/hermes#569 — Crypto perf](https://github.com/facebook/hermes/issues/569)
- [margelo/react-native-worklets-core](https://github.com/margelo/react-native-worklets-core)

**Static Hermes / hermes-node:**
- [Mikov tweet, hermes-node announcement](https://x.com/tmikov/status/2024609186936660170)
- [Static Hermes discussion](https://github.com/facebook/hermes/discussions/1137)
- [Static Hermes perf writeup, July 2025](https://github.com/facebook/hermes/blob/static_h/doc/blog/2025-07-15-static-h-performance-june-2025.md)
- [RN 0.84 Hermes V1 default](https://reactnative.dev/blog/2026/02/11/react-native-0.84)

**Other:**
- [awslabs/llrt](https://github.com/awslabs/llrt)
- [lynx-family/primjs](https://github.com/lynx-family/primjs)
- [socketsupply/socket](https://github.com/socketsupply/socket)
- [uniffi-bindgen-react-native](https://github.com/jhugman/uniffi-bindgen-react-native)
- [jedisct1/libsodium.js](https://github.com/jedisct1/libsodium.js)
- [holepunchto/hypercore#234 — browser support](https://github.com/holepunchto/hypercore/issues/234)
