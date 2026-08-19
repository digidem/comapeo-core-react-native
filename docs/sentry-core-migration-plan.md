# Plan: replace `@sentry/node-core` with `@sentry/core` in the backend

**Status: implemented.** Landed on branch
`claude/sentry-node-core-bundle-size-nzic8m`, merged with `main` at
`1.0.0-pre.12` (nodejs-mobile 24, V8 compile cache, undici taken from Node)
and re-measured against that baseline on 2026-08-19. Backend unit tests are
green (110/110). The bundle figures below are exact bytes from a production
`backend:build` of each side, so both columns come from the same toolchain.

**Device validation (Pixel_7a_API_34 emulator, `apps/integration` release
builds, org `awana-digital`, project `core-react-native-integration`).** The
tripwire passed on both a pre-migration (`origin/main`) and a migrated build
on 2026-08-16 — full boot trace, native child spans, Node-side
`boot.loader-init`/`boot.manager-init` in the same trace, tags, and PII
scan — and passes again on 2026-08-19 against the post-merge build. Two
tripwire assertions were corrected first (op `"boot"` and device.family; both
contradicted all 894 production boot transactions from the last 30 days, so
they were pre-existing drift, not migration effects — the pre-migration build
passing the corrected assertions confirms this). Node events from the migrated
build still report `sdk.name: sentry.javascript.node-core` (10.70.0), and the
`comapeo.boot.phase_duration_ms` metrics pipeline delivers from both builds.

The on-device numbers are in [Boot cost on device](#boot-cost-on-device);
the short version is that the SDK load+init phase is 5× faster, the FGS
carries ~4 MB less PSS and ~7 MB less peak RSS, and total boot-to-ready
improves ~4%.

## Motivation

`@sentry/node-core` pulls in `@sentry/opentelemetry` and five
`@opentelemetry/*` packages. In the built backend that stack is a **432 KB
minified chunk** (plus ~22 KB of OTel side-chunks) that is parsed and
evaluated on every production boot — the chunk is "lazy" (gated on
`--sentryDsn`), but production builds always pass a DSN, so in practice it
loads on every FGS start. Parsing and evaluating that code costs startup time
and memory at exactly the moment the Android FGS is most vulnerable to
low-memory kills on low-end devices.

The twist that makes this cheap to fix: **we already use almost none of what
`@sentry/node-core` adds over `@sentry/core`.**

- We register **no OTel auto-instrumentations** (`sentry-init.js` wires the
  provider by hand with an empty instrumentation set).
- We use a **custom transport** (envelopes forwarded over the control socket
  to native — `forwardingTransport` in `lib/sentry.js`), so node-core's HTTP
  transport is dead code.
- ESM loader hooks are already disabled (`registerEsmLoaderHooks: false`).
- Uncaught-exception/unhandled-rejection capture goes through `index.js`'s own
  `handleFatal` handlers, not node-core's integrations.
- We delete the `os`/`device`/`culture` contexts that node-core's
  `nodeContextIntegration` computes (native fills them at capture time).

The entire OTel layer exists only to make node-core's tracing API work. But
`@sentry/core` ships its own complete, OTel-free tracing implementation —
`startSpan`, `startInactiveSpan` (incl. `parentSpan`, `startTime`,
`forceTransaction`), `continueTrace`, `tracesSampler` with
`inheritOrSampleWith` — the same one `@sentry/browser`, `@sentry/deno`, and
`@sentry/vercel-edge` use. Every API the backend calls exists in
`@sentry/core` (verified against `@sentry/core` 10.x in this repo's
lockfile), including `metrics.count/distribution/gauge`, `consoleIntegration`
(node-core's is a thin wrapper over core's), logs (`enableLogs` /
`beforeSendLog`), `addEventProcessor`, `captureException`, and `flush`.

## Measured savings

Methodology: two full `rolldown` production builds of this repo's backend —
baseline (pre-migration `main`) vs. the `@sentry/core`-only backend. Bundle
sizes below are from the landed build; the load/memory metrics were measured
against the prototype and have not been re-run since (the code paths they
exercise are unchanged). Load metrics are medians of 5
fresh-process runs on desktop Linux x64, Node v22.22.2, importing the built
Android `sentry-init` chunk with `--expose-gc` and measuring around
`import()` + `initSentry()`. `--jitless` runs (iOS-like V8 config) gave the
same deltas within noise.

### Bundle size (minified bytes, real build output)

These are the **landed** figures, re-measured on 2026-08-19 against `main` at
`1.0.0-pre.12`; both columns are the `assets/nodejs-project/**.mjs` output of
a production backend build of that commit. They are ~395 KB smaller on both sides
than the figures this section carried before, because `main` since dropped the
bundled `undici` in favour of Node 24's built-in one — that shrinks `index.mjs`
for both variants and does not touch the Sentry delta.

| Artifact | Baseline | Core-only (landed) | Delta |
|---|---:|---:|---:|
| `chunks/sentry-init-*.mjs` (Android, lazy) | 441,707 | 84,819 | **−356,888 (−80.8%)** |
| OTel side-chunks (`esm-*`, `getMachineId-*` ×5, `execAsync-*`) | 20,025 | 0 | −20,025 |
| shared `src-*.mjs` chunk | 9,934 | 0 | inlined into `index.mjs` ¹ |
| `chunks/sentry-*.mjs` (always-on adapter) | 9,975 | 9,949 | −26 |
| `rolldown-runtime-*` + `file-*` chunks | 2,245 | 2,060 | −185 |
| `index.mjs` (Android) | 2,847,755 | 2,857,198 | +9,443 ¹ |
| `loader.mjs` (Android) | 847 | 847 | 0 |
| **Total Android JS** | **3,332,488** | **2,954,873** | **−377,615 (−11.3%)** |
| `sentry-init` chunk gzipped (Android) | 144,147 | 27,870 | −80.7% |

The iOS bundle differs only in the `__loadAddon` banner, and its
`sentry-init-*.mjs` lands within ~30 bytes of the Android one; the
per-artifact story is identical across platforms.

¹ `index.mjs` grows by almost exactly the size of the `src-*.mjs` chunk that
disappears, because that is what happened: `src-*.mjs` was a shared chunk
that both `index.mjs` and the Sentry chunk imported, and once the Sentry
chunk stopped importing it, rolldown inlined it into its single remaining
consumer. No code was added — it moved. `index.mjs` contains **no**
`@sentry/*` code before or after (verified by grep on the built output); the
envelope serializer used by `sentry-frame.js` lives in the lazy
`sentry-init` chunk, not the main bundle.

The surviving ~85 KB is `@sentry/core` itself (client, scope, tracing,
envelope, logs, metrics) plus our adapter code — the part that does the work
we actually rely on.

### What is in the removed bytes

Per-package attribution of the baseline chunk's 441,707 bytes, computed from
the build's own sourcemap (segment-by-segment byte counting, 99.99%
attributed):

| Source | Bytes | Share | What it is |
|---|---:|---:|---|
| OpenTelemetry stack (`api`, `core`, `sdk-trace-*`, `semantic-conventions`, `instrumentation`, `resources`, `context-async-hooks`, `api-logs`, + `import/require-in-the-middle`, `module-details-from-path`) | ~148,000 | 33% | A second, complete tracing implementation: tracer/span SDK and processor pipeline; **44 KB of semantic-convention constant tables**; the module-hooking machinery (`import-in-the-middle`/`require-in-the-middle`) that exists to patch libraries we never instrument; host/OS/process resource detectors incl. the machine-id probes that also emitted the `getMachineId-*`/`execAsync` side-chunks (they shell out to `ioreg`/registry readers — pure dead weight in an FGS). |
| `@sentry/node-core` | 112,229 | 25% | The node SDK surface: the **ANR watchdog integration alone is 47 KB** (it embeds its worker script as an inline string); `localVariables` (inspector-protocol debugger client, ~10 KB); `contextLines`; `nodeContext`; HTTP-server span + undici/fetch instrumentation; cron monitor helpers; a **vendored HTTP(S) proxy agent** for its HTTP transport; `pino` and `spotlight` integrations; the node transport itself. |
| `@sentry/opentelemetry` | 24,398 | 6% | The Sentry↔OTel bridge (`SentrySampler`, `SentrySpanProcessor`, `SentryPropagator`, context manager) — needed only because node-core's tracing *is* OTel. |
| `@sentry/core` retained by node-core's import graph | ~66,000 | 15% | Core code only node-core's exports reference, treeshaken away in the prototype: the **Supabase integration (4.7 KB)**, **MCP-server session extraction (4.4 KB)**, HTTP server-subscription handling, `requestData`, IP-address extraction, etc. |
| `@sentry/core` we keep | ~82,000 | 19% | Client, scope, tracing, envelope serialization, logs, metrics — what the prototype chunk consists of (97% `@sentry/core`, 3% our adapters). |

Why so much dead code survives the bundler: `sentry-init.js` does
`import * as Sentry from "@sentry/node-core"` and injects the namespace into
`sentry.js`, which forces rolldown to retain node-core's **entire public
export surface** — every integration and helper it exports, whether or not
anything calls it — plus everything those exports pull from `@sentry/core`
and OTel. The prototype's explicitly-constructed namespace is what lets
treeshaking actually work.

The practical upshot: of the ~357 KB removed, the overwhelming majority is
code that **cannot execute under our configuration** (ANR/cron/proxy/pino/
spotlight/localVariables are never enabled; the HTTP transport is replaced by
the IPC forwarding transport; no instrumentations are registered so the
hooking machinery has nothing to hook). The genuinely-live code we give up is
only the short list in the behavior-deltas table below.

### Load time and memory (desktop proxy for on-device cost)

| Metric (import + `Sentry.init`, fresh process) | node-core stack | core-only | Delta |
|---|---:|---:|---:|
| `import()` wall time | 124 ms | 18 ms | **−85%** |
| `Sentry.init()` wall time | 30 ms | 7 ms | −77% |
| V8 heap delta (post-GC) | 6.2 MB | 1.1 MB | **−5.1 MB (−82%)** |
| Process RSS delta | 36.5 MB | 5.5 MB | −31 MB (−85%) |

Caveats: desktop x64 numbers are a proxy. On-device the absolute times will
be several times larger (slow cores; jitless V8 on iOS makes parse/eval
relatively more expensive), but the *ratios* should hold since both variants
are plain JS through the same pipeline. The RSS delta overstates what a
low-end phone will reclaim (desktop V8 reserves generously); the heap delta
(−5 MB) is the conservative floor. These were the pre-merge predictions; the
device measurements below supersede them.

### Boot cost on device

Measured 2026-08-19 on a Pixel_7a_API_34 emulator (Apple-silicon host),
`apps/integration` release builds of `main` vs. this branch, installed and
benchmarked alternately in five blocks so host-load drift cancels out. Each
boot is `am force-stop` → `am start` → wait for the `ready` control frame,
then `VmHWM`/`VmRSS` from `/proc/<fgs-pid>/status`, `TOTAL PSS` from
`dumpsys meminfo`, and `utime+stime` from `/proc/<fgs-pid>/stat`.

Since `main`, the FGS runs node with `NODE_COMPILE_CACHE` pointed at
`cache/node-compile-cache`, so a boot that finds a populated cache skips most
compilation. **Warm** below means that cache is populated — the steady state
for a device that has booted the app before. **Cold** means the cache
directory was wiped before the boot, which is what every first boot after an
install or app update sees.

Warm, 38 boots per variant:

| Metric | node-core | core-only | Delta |
|---|---:|---:|---:|
| `boot.loader-import-sentry-node` (SDK load + init) | 1118 ms | 200 ms | **−82%** |
| FGS CPU time at `ready` (n=16) | 6.12 s | 5.86 s | −0.26 s (−4%) |
| proc-start → `ready` (wall) | 10.22 s | 9.84 s | −0.38 s (−4%) |
| FGS peak RSS (`VmHWM`) | 245.2 MB | 237.8 MB | **−7.4 MB (−3.0%)** |
| FGS PSS after `ready` | 107.0 MB | 103.0 MB | **−4.0 MB (−3.7%)** |
| compile cache on disk | 3.4 MB | 2.9 MB | −0.5 MB |

Cold, 12 boots per variant:

| Metric | node-core | core-only | Delta |
|---|---:|---:|---:|
| FGS CPU time at `ready` (n=8) | 6.13 s | 5.96 s | −0.17 s |
| proc-start → `ready` (wall) | 10.21 s | 9.79 s | −0.42 s |
| FGS peak RSS (`VmHWM`) | 262.5 MB | 252.4 MB | −10.1 MB |
| FGS PSS after `ready` | 107.4 MB | 101.5 MB | **−5.9 MB (−5.5%)** |

All figures are medians. The memory result is the solid one: per-block PSS
medians never overlap between the variants (node-core 106.7–109.1 MB, core-only
101.2–104.5 MB across blocks), which is the number that matters for the
low-memory killer. Wall-clock boot time is the weak one — the host was busy
(load average ~13 on 12 cores) and single-boot times spread over several
seconds, so the −4% is only worth as much as the CPU-time measure that agrees
with it.

One honest caveat about the time saving: the SDK load+init phase gets ~0.9 s
faster, but only ~0.26 s of that reaches the total. `boot.import-index` — the
`index.js` import that follows — is consistently ~0.6–0.9 s *longer* on the
core-only build, both in the Sentry spans and in an independent logcat phase
measurement. It is not a compile-cache miss: both builds cache `index.mjs`
identically (verified by listing the cache directory). The likeliest
explanation is heap warm-up — the node-core build has already grown V8's heap
by the time `index.mjs` is evaluated, so the core-only build pays that growth
during the index import instead, which is consistent with its lower peak RSS.
Unconfirmed; the CPU-time measure is the honest bound on the total saving.

The relevant fleet reference: production `boot.loader-import-sentry-node`
runs p50 101 ms · avg 195 ms · p95 567 ms over 30 days of node-core builds,
so the span this change collapses is a real fraction of real boots, not just
an emulator artifact.

## What changes

### New code to write (~170 lines, both files already written and validated as the prototype)

1. **`backend/lib/als-async-context.js` (~60 lines)** — an
   `AsyncLocalStorage`-based async context strategy for `@sentry/core`,
   replacing the OTel context manager. Uses only public-ish core APIs:
   `setAsyncContextStrategy`, `getDefaultCurrentScope`,
   `getDefaultIsolationScope`. SDK v11 turned this into
   `setAsyncLocalStorageAsyncContextStrategy` in `@sentry/server-utils` and
   made it what `@sentry/node` installs unless `enableOpenTelemetrySetup` is
   set; our file matches it method for method, so the v11 upgrade can delete
   it in favour of that import. (`@sentry/server-utils` is not usable before
   then: it pins core v11 and still depends on `@opentelemetry/api`.)

2. **`backend/lib/sentry-init.js` (rewrite, ~100 lines)** — drop all OTel
   wiring; build a minimal `init()` on `initAndBind(ServerRuntimeClient, …)`
   with `createStackParser(nodeStackLineParser())`, the existing forwarding
   transport, and a hand-picked default-integration list
   (`eventFiltersIntegration`, `functionToStringIntegration`,
   `linkedErrorsIntegration`). Export the same `initSentry(argv, storageDir)`
   contract, injecting a namespace object with the exact API surface
   `sentry.js`/`metrics.js` consume. **No changes to `sentry.js`,
   `metrics.js`, `before-send.js`, `sentry-frame.js`, `loader.mjs`, or
   `index.js` logic** — the injected-SDK seam absorbs the whole swap.

### Mechanical changes

- **`backend/package.json`**: remove `@sentry/node-core`,
  `@sentry/opentelemetry`, `@opentelemetry/api`, `@opentelemetry/core`,
  `@opentelemetry/instrumentation`, `@opentelemetry/sdk-trace-base`,
  `@opentelemetry/sdk-trace-node`, `@opentelemetry/semantic-conventions`
  (grep confirms nothing else in `backend/` imports OTel). `@sentry/core` is
  already a direct dependency (for `serializeEnvelope`) and becomes the only
  Sentry runtime dep.
- **Tests**: `lib/sentry.test.mjs` and `lib/sync-observer.test.mjs` import
  `@sentry/node-core` for `close`/`captureMessage`; switch those imports to
  `@sentry/core` (same functions, same global carrier — the prototype passed
  both suites even *without* this change, because node-core re-exports them).
- **JSDoc types**: `typeof import("@sentry/node-core")` annotations in
  `sentry.js` / `metrics.js` become a small local `SentrySdk` typedef (or
  `typeof import("@sentry/core")` plus the custom `init`).
- **Comments/docs**: `loader.mjs`, `rolldown.config.ts` chunk comments,
  `docs/ARCHITECTURE.md`, `docs/sentry-integration.md` §5/§6 references to
  the node-core + OTel stack.

### Effort estimate

**~1–2 engineer-days total**, most of it validation rather than code:

- Core code: already de-risked — the prototype in the appendix builds and
  passes all 97 backend unit tests (including span/transaction/envelope
  forwarding and boot-trace continuation) without touching any test.
- Half a day for the mechanical changes + doc updates.
- Half a day to a day for validation: tripwire run against a test build
  (below), plus an on-device before/after boot benchmark in
  `apps/integration`.

## Behavior deltas (what node-core's defaults did that we lose)

| node-core default integration | Verdict | Rationale |
|---|---|---|
| `inboundFilters`, `functionToString`, `linkedErrors` | **Kept** | These are core integrations; re-registered explicitly. |
| `onUncaughtException`, `onUnhandledRejection` | No loss | `index.js` `handleFatal` already owns this path and calls `captureFatal`. |
| `nodeContext` (os/device/culture/app contexts) | **No loss** | We already delete `os`/`device`/`culture` (native fills them). `runtime` context is preserved via `ServerRuntimeClient`'s `runtime` option. `app.app_start_time`/`app_memory` are restored by the small `appContextIntegration` in `sentry-init.js`. |
| `httpIntegration` / `nativeNodeFetchIntegration` | **Accepted loss** | Outbound-HTTP breadcrumbs (e.g. remote map downloads) disappear from Node-side events. No spans are lost — we never registered instrumentations, and RPC/boot/sync spans are all manual. If breadcrumbs prove missed, a small undici `diagnostics_channel` subscriber can restore them later. |
| `contextLines` | Accepted loss | It would inline *minified bundle* lines; real source context comes from the uploaded sourcemaps, so value was near zero. |
| `localVariables` | Accepted loss | Inspector-based; of doubtful function under nodejs-mobile anyway. |
| `modules` | No loss | Lists `node_modules` packages — the rolled-up bundle has none at runtime. |
| `childProcess`, `processSession`, `systemError`, `requestData`, `conversationId` | Accepted loss | No child processes in the FGS; release-health sessions are owned by the native SDKs; the rest are marginal. |
| `consoleIntegration` (debug-only, opt-in) | **Kept** | node-core's is a wrapper over `@sentry/core`'s `consoleIntegration`; use core's directly. |
| Logs (`enableLogs`, `beforeSendLog`) | Kept, one nuance | Both are handled by the core client. `NodeClient` also flushed logs on `beforeExit`; our shutdown path already calls `sentry.flush()` explicitly. Optionally add a one-line `beforeExit` listener for crash-adjacent parity. |
| SDK metadata (`event.sdk.name = sentry.javascript.node-core`) | **Kept** | `sentry-init.js` calls `applySdkMetadata(clientOptions, "node-core", ["core"])`, so `sdk.name` is unchanged (existing dashboards/alerts keep matching) while the reported package list names `@sentry/core`. |

Tracing semantics: core's `SentrySpan` tree replaces OTel spans. All options
we use (`parentSpan`, `startTime`, `forceTransaction`, `onlyIfParent`-free
paths, `tracesSampler` with `inheritOrSampleWith`) are supported by core's
implementation (verified in `@sentry/core` 10.x source). The
`withBootTrace` workaround comment about ended `parentSpan`s under the OTel
backend may even become unnecessary — leave the code as-is and verify trace
shape via the tripwire. This is the main risk area, and it has a purpose-built
detector (below).

## Validation plan

1. **Unit tests** (`npm run backend:test`) — already green against the
   prototype; land the test-import swap with the change.
2. **Tripwire** (`scripts/sentry-tripwire.mjs`, issue #69) — the existing
   trace-shape assertion (boot transaction, native child spans, cross-process
   `boot.loader-init` / `boot.manager-init` stitching) is SDK-agnostic and is
   precisely the regression detector for "tracing compiles but arrives with
   the wrong shape". Run it against a test build pointed at a test Sentry
   project, on both platforms.
3. **On-device before/after** — one boot-benchmark run in `apps/integration`
   on a low-end Android device: FGS process RSS after `ready`, and the
   `boot.loader-import-sentry-node` duration from logcat/Sentry.
4. **Post-rollout** — watch `comapeo.boot.phase_duration_ms` and the
   loader-import span in the Sentry dashboard; the improvement should be
   visible fleet-wide without any new instrumentation.

## Rollout steps

1. Land `als-async-context.js` + the `sentry-init.js` rewrite + test-import
   swap + dependency removal in one PR (the seam keeps it self-contained).
2. Run the tripwire against a pre-release build on both platforms.
3. Update `docs/ARCHITECTURE.md` / `docs/sentry-integration.md` (§5 bundle
   strategy, §6 SDK wiring) in the same PR.
4. Ship in the next pre-release; compare boot metrics for one release cycle.

Rollback is a one-commit revert: no native code, no IPC contract, no
`sentry.js` behavior, and no CLI flags change.

## Alternatives considered

- **Named imports from `@sentry/node-core` (no replacement)**: change
  `import * as Sentry` + namespace injection to explicit named imports so
  treeshaking can drop the unused export surface, keeping node-core and the
  OTel wiring untouched. Measured (same build + bench methodology, 97/97
  tests pass): chunk 441.7 KB → **346.5 KB** (−95 KB — ANR, cron, pino,
  spotlight and ~34 KB of core they referenced disappear), but **load cost
  is unchanged**: import 121 ms (vs 124), `init` 31 ms (vs 30), heap
  −0.24 MB, RSS −7 MB. The dropped modules were never-executed function
  bodies that V8 lazy-parses cheaply; what dominates startup is the code
  that *runs* at import/init — the OTel tracer SDK, hooking machinery,
  semconv tables, and node-core's default-integration graph — and named
  imports cannot remove any of it, because `init()` and the OTel wiring
  reference it statically. Worth taking only as an incidental cleanup; it
  delivers ~5% of the win for ~40% of the diff. The startup/memory goal
  requires removing what executes, i.e. the core-only migration.
- **Keep node-core, drop OTel**: not possible — node-core hard-depends on
  `@sentry/opentelemetry` and the OTel API; its scope/context model *is* the
  OTel context manager.
- **Wait for upstream**: Sentry has no announced OTel-free Node SDK tier
  below node-core; `@sentry/deno` and `@sentry/vercel-edge` demonstrate that
  a core-only server client is a supported, stable pattern rather than a
  hack.
- **Do nothing**: keeps ~370 KB of parse/eval and ~5 MB heap (likely more
  RSS) on every production FGS boot for machinery we configure into a no-op.

## Appendix: the prototype these measurements came from

Kept as the historical record of what was measured. The landed
`backend/lib/als-async-context.js` and `backend/lib/sentry-init.js` are this
code productionised — real JSDoc types instead of `any`, proper file headers,
plus the two parity items the deltas table lists as optional
(`applySdkMetadata` and a small `contexts.app` integration). Read the source
files, not this appendix, for current behaviour.

`als-async-context.js`:

```js
// AsyncLocalStorage-based async context strategy for @sentry/core.
// Replaces the @sentry/opentelemetry context-manager strategy that
// `@sentry/node-core`'s `init` installs. Adapted from
// `@sentry/vercel-edge`'s `async.ts` (MIT).

import { AsyncLocalStorage } from "node:async_hooks";
import {
  getDefaultCurrentScope,
  getDefaultIsolationScope,
  setAsyncContextStrategy,
} from "@sentry/core";

export function setAlsAsyncContextStrategy() {
  const asyncStorage = new AsyncLocalStorage();

  function getScopes() {
    return (
      asyncStorage.getStore() ?? {
        scope: getDefaultCurrentScope(),
        isolationScope: getDefaultIsolationScope(),
      }
    );
  }

  setAsyncContextStrategy({
    withScope(callback) {
      const { scope, isolationScope } = getScopes();
      const newScope = scope.clone();
      return asyncStorage.run({ scope: newScope, isolationScope }, () =>
        callback(newScope),
      );
    },
    withSetScope(scope, callback) {
      const { isolationScope } = getScopes();
      return asyncStorage.run({ scope, isolationScope }, () => callback(scope));
    },
    withIsolationScope(callback) {
      const { scope, isolationScope } = getScopes();
      const newIsolationScope = isolationScope.clone();
      return asyncStorage.run(
        { scope, isolationScope: newIsolationScope },
        () => callback(newIsolationScope),
      );
    },
    withSetIsolationScope(isolationScope, callback) {
      const { scope } = getScopes();
      return asyncStorage.run({ scope, isolationScope }, () =>
        callback(isolationScope),
      );
    },
    getCurrentScope: () => getScopes().scope,
    getIsolationScope: () => getScopes().isolationScope,
  });
}
```

`sentry-init.js` (rewrite):

```js
// @sentry/core-only replacement for the @sentry/node-core +
// @sentry/opentelemetry + OpenTelemetry SDK stack. Same external
// contract: `initSentry(argv, storageDir)` called from loader.mjs via
// gated dynamic import.

import {
  addEventProcessor,
  captureException,
  captureMessage,
  close,
  consoleIntegration,
  continueTrace,
  createStackParser,
  eventFiltersIntegration,
  flush,
  functionToStringIntegration,
  getClient,
  getCurrentScope,
  getIntegrationsToSetup,
  initAndBind,
  linkedErrorsIntegration,
  metrics,
  nodeStackLineParser,
  ServerRuntimeClient,
  startInactiveSpan,
  startSpan,
} from "@sentry/core";

import { setAlsAsyncContextStrategy } from "./als-async-context.js";
import { envelopeToFrame } from "./sentry-frame.js";
import * as sentry from "./sentry.js";

// The core defaults we keep from node-core's list. The node-specific
// ones (http, nativeNodeFetch, contextLines, localVariables, modules,
// nodeContext, childProcess, processSession, onUncaughtException,
// onUnhandledRejection) are irrelevant in the FGS, replaced by
// native-side context, or covered by index.js's handleFatal handlers.
function getDefaultIntegrations() {
  return [
    eventFiltersIntegration(),
    functionToStringIntegration(),
    linkedErrorsIntegration(),
  ];
}

// Minimal `Sentry.init` on @sentry/core primitives — the same shape
// @sentry/deno and @sentry/vercel-edge use.
function init(options) {
  setAlsAsyncContextStrategy();
  const clientOptions = {
    ...options,
    platform: "node",
    runtime: { name: "node", version: process.version },
    stackParser: createStackParser(nodeStackLineParser()),
    integrations: getIntegrationsToSetup({
      defaultIntegrations: getDefaultIntegrations(),
      integrations: options.integrations,
    }),
  };
  if (options.initialScope) getCurrentScope().update(options.initialScope);
  return initAndBind(ServerRuntimeClient, clientOptions);
}

// Namespace with the exact API surface sentry.js / metrics.js use, so
// the injected-SDK contract is unchanged.
const SentryCoreSdk = {
  init,
  addEventProcessor,
  captureException,
  captureMessage,
  close,
  consoleIntegration,
  continueTrace,
  flush,
  getClient,
  metrics,
  startInactiveSpan,
  startSpan,
};

export function initSentry(argv, storageDir) {
  sentry.init({ Sentry: SentryCoreSdk, argv, envelopeToFrame, storageDir });
}
```
