# Sentry Integration Plan

How we propose to wire Sentry error reporting and RPC tracing into
`@comapeo/core-react-native` without forcing every consumer of this
module to ship Sentry. The integration is **opt-in and host-app
driven** so that only the CoMapeo Mobile app pays the bundle cost,
sends events to a DSN, and sees its data in Sentry — other apps that
depend on this module continue to ship with no Sentry traffic and no
Sentry binaries.

Companion docs:
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — process model, IPC, lifecycle.
- Reference implementation in CoMapeo Mobile:
  [`comapeo-mobile/src/backend/src/app.js`](https://github.com/digidem/comapeo-mobile/blob/develop/src/backend/src/app.js).
- Upstream OpenTelemetry instrumentation in `@comapeo/core`:
  [`comapeo-core PR #1051`](https://github.com/digidem/comapeo-core/pull/1051).

---

## 1. Goals & non-goals

### Goals

1. **Capture errors** raised at every layer the module owns:
   - Node backend: `uncaughtException`, `unhandledRejection`, boot
     phase failures (`listen-control`, `init`, `construct`,
     `runtime`), per-RPC throws.
   - RN/JS layer: `state` ERROR transitions, `messageerror` protocol
     parse failures, RPC client rejections.
   - Native: rootkey load failures, watchdog timeouts, IPC
     connection errors, hard process crashes (Android FGS,
     iOS in-process).
2. **Trace RPC calls** end-to-end across the React Native ↔ Node
   boundary, mirroring the `onRequestHook` pattern used in
   `comapeo-mobile/src/backend/src/app.js`. Each RPC call appears
   as a transaction whose parent span is the JS-side caller.
3. **Forward OpenTelemetry spans** emitted by `@comapeo/core` (once
   PR #1051 lands) to Sentry without bundle-time coupling to a
   specific exporter.
4. **App-specific gating**: zero Sentry traffic, zero Sentry SDK
   activation, and ideally zero meaningful bundle delta for any
   consumer that doesn't opt in.

### Non-goals

- We are not adding a generic telemetry abstraction. The module
  speaks Sentry-shaped APIs (DSN, `Sentry.captureException`,
  OpenTelemetry-compatible spans). Other backends are out of scope.
- We are not capturing user-PII or message contents. Spans get
  method names and structural metadata, not arguments.
- We are not auto-installing Sentry SDKs on the host app's behalf.
  The host app declares the dependency; the module just wires it in.

---

## 2. Why "app-specific" matters here

`@comapeo/core-react-native` is a library. It has at least two
different consumers expected over time (the CoMapeo Mobile app, and
the in-tree `apps/example` integration harness — and potentially
third-party apps building on the module). We cannot:

- **Bundle a hard dependency on `@sentry/node` into the published
  Node backend.** That bundle is staged into
  `android/src/{debug,main}/assets/nodejs-project/` and
  `ios/nodejs-project/` at `npm run backend:build` time
  (see `backend/rollup.config.ts` and
  `scripts/build-backend.ts`). Whatever ends up in the rollup is on
  every consumer's device, regardless of whether they want Sentry.
- **Hard-import `@sentry/react-native` from `src/`.** Doing so
  would force every consumer to install it, and any consumer that
  does not call `Sentry.init()` would still get a runtime warning
  from the module attempting to use an uninitialized client.
- **Ship a DSN.** The DSN is per-app secret (well, per-app config).
  It belongs in the host app's environment, not in the published
  module's source.

The integration must therefore be:

1. **Inert by default.** Module installed but not configured → no
   Sentry calls, no SDK init, no trace metadata on RPC frames.
2. **Activated by the host app.** A single configuration entry
   point, called from the host app's startup code, switches
   instrumentation on with a DSN, environment, release, sample
   rates, etc.
3. **Reachable from all three layers.** The same call from JS must
   propagate to the Node backend (so it can `Sentry.init()` and
   register `onRequestHook`) and to native (so iOS/Android crash
   reporters can be enabled).

---

## 3. Layered architecture

There are three independent Sentry scopes to manage. They share a
DSN and a release tag, but each runs in its own process / runtime
and needs its own SDK init.

```
┌──────────────────────────── Host app ─────────────────────────────┐
│                                                                   │
│    ┌─────────────── React Native (JS) ────────────────┐           │
│    │  @sentry/react-native                            │           │
│    │  - JS errors, native crashes (iOS+Android)       │           │
│    │  - starts trace for RPC calls                    │           │
│    │                                                  │           │
│    │  @comapeo/core-react-native:                     │           │
│    │  - state.on('stateChange', ERROR) → captureException        │
│    │  - state.on('messageerror', ...) → captureException         │
│    │  - comapeo.<method>() wrapper: startSpan +       │           │
│    │      attach sentry-trace + baggage in metadata   │           │
│    └──────────────────────────────────────────────────┘           │
│                            │                                      │
│                            │ control.sock {type:"init",sentry:…}  │
│                            │ comapeo.sock RPC (with sentry-trace) │
│                            ▼                                      │
│    ┌─────────────────── Node backend ─────────────────┐           │
│    │  @sentry/node (bundled, init only on opt-in)     │           │
│    │  - handleFatal → captureException                │           │
│    │  - createMapeoServer({ onRequestHook }) → spans  │           │
│    │  - OpenTelemetry processor sends @comapeo/core   │           │
│    │      spans (PR #1051) to Sentry transport        │           │
│    └──────────────────────────────────────────────────┘           │
│                            │                                      │
│                            │ shared DSN/release/env               │
│                            ▼                                      │
│    ┌─────────────────── Native (FGS) ─────────────────┐           │
│    │  Android: sentry-android via @sentry/react-native│           │
│    │  iOS: sentry-cocoa via @sentry/react-native      │           │
│    │  - hard crash reports                            │           │
│    │  - we forward NodeJSService ERROR transitions    │           │
│    │      with phase tag for correlation              │           │
│    └──────────────────────────────────────────────────┘           │
└───────────────────────────────────────────────────────────────────┘
```

Key splits:

- **JS and native** share a single `@sentry/react-native` SDK that
  the host app installs and initializes. The module never imports
  `@sentry/react-native` directly; it accepts a Sentry-shaped
  adapter object that the host hands in (see §4.1).
- **Node backend** runs a separate `@sentry/node` SDK, initialized
  inside the bundle. Configuration arrives over the existing
  control socket, embedded in the `init` frame alongside the
  rootkey (see §4.2). The DSN is therefore short-lived in argv-free
  memory only.
- **Android FGS process** has no JS bridge but does reach the
  same Sentry-android SDK if the host app's `MainApplication`
  initializes it before starting the FGS. Cross-process attribution
  is via `release`+`environment`+a `proc:fgs` tag, not a shared
  client.

---

## 4. Configuration API

### 4.1 Public JS API

A new sub-export so the import is explicit and tree-shakable:

```ts
// File: src/sentry.ts (new)
import type * as SentryReactNative from "@sentry/react-native";

export type SentryAdapter = Pick<
  typeof SentryReactNative,
  | "captureException"
  | "captureMessage"
  | "startSpan"
  | "continueTrace"
  | "getActiveSpan"
  | "getTraceData"
>;

export interface ComapeoSentryConfig {
  /**
   * The host app's already-initialized `@sentry/react-native`
   * module (or any object satisfying `SentryAdapter`). The
   * module never calls `Sentry.init()` itself; the host app
   * has done that with its DSN before this call.
   */
  sentry: SentryAdapter;

  /**
   * DSN + meta to forward to the Node backend's own
   * `@sentry/node` init. Backend runs in its own runtime
   * (separate process on Android, same process on iOS) so
   * it needs its own SDK boot. Pass `null` to skip
   * backend-side Sentry entirely (e.g. you only want JS
   * errors).
   */
  backend: null | {
    dsn: string;
    environment?: string;
    release?: string;
    sampleRate?: number;          // error sampling
    tracesSampleRate?: number;    // span sampling
    /**
     * Optional hard cap on the size of `request.args` we
     * serialize into rpc spans. Defaults to 0 — args are NOT
     * captured by default to avoid PII. Set to a small number
     * to capture truncated args during debugging.
     */
    rpcArgsBytes?: number;
  };
}

/**
 * Wires Sentry into this module. Idempotent and one-shot:
 * the first call wins; subsequent calls log a warning.
 *
 * Must be called *before* the first RPC method on `comapeo`
 * is invoked, so that the request-side span wrapper is in
 * place. State observers are wired immediately on call.
 */
export function configureSentry(config: ComapeoSentryConfig): void;
```

Consumer usage in CoMapeo Mobile (host app):

```ts
import * as Sentry from "@sentry/react-native";
import { configureSentry } from "@comapeo/core-react-native/sentry";

Sentry.init({ dsn: process.env.SENTRY_DSN, /* ... */ });

configureSentry({
  sentry: Sentry,
  backend: {
    dsn: process.env.SENTRY_DSN,
    environment: __DEV__ ? "development" : "production",
    release: APP_VERSION,
    tracesSampleRate: 0.1,
  },
});
```

Apps that don't want Sentry simply never import
`@comapeo/core-react-native/sentry`. The main barrel
(`@comapeo/core-react-native`) keeps no Sentry imports and the
adapter type is the only thing pulled into typecheck for those
that do opt in.

### 4.2 Plumbing the backend config

The Node backend can't read `process.env` from the host RN app —
it's a separate JS runtime. The control socket already carries the
boot handshake; we extend the existing `init` frame:

```js
// Native → Node
{
  type: "init",
  rootKey: "<base64>",
  sentry: {                      // new, optional
    dsn: "https://…",
    environment: "production",
    release: "1.4.2",
    sampleRate: 1.0,
    tracesSampleRate: 0.1,
    rpcArgsBytes: 0
  }
}
```

Why piggyback on `init` rather than a separate frame:
- Init is already a one-shot, validated frame
  (`backend/index.js:57-103`). Adding an optional sibling field
  costs ~10 lines of validation.
- Sentry init must complete **before** `MapeoManager` is
  constructed (so span context is available for any boot-time
  spans we add) and **before** `ComapeoRpcServer.listen` (so the
  `onRequestHook` is registered). The current init handler is the
  exact moment we need.
- The control socket is already AF_UNIX local; the DSN never
  hits the wire outside the device.

The native side reads the DSN/environment/release from a
platform-specific source. The simplest path: `configureSentry()`
stashes the backend config into `state` (or a sibling), and
the native module reads it back when it builds the `init` frame.
Specifically:

- Add a new native bridge method `setSentryConfig(json: string)`
  that the JS sub-export calls before the rootkey handshake
  completes. Native stores it as a property on `NodeJSService`.
- `NodeJSService.sendInit(rootKey)` includes `sentryConfig` in
  the payload if set.

If `configureSentry()` is called too late (after init has been
sent), we fall back to a separate `sentry-init` control frame
sent post-handshake — the backend's RPC server will then
re-register its `onRequestHook` with the configured Sentry
client. Calls already in flight at that moment are not traced
(documented limitation).

---

## 5. Backend instrumentation (`backend/`)

Mirrors `comapeo-mobile/src/backend/src/app.js`, adapted to this
module's two-socket boot.

### 5.1 Bundle strategy

`@sentry/node` becomes a `dependencies` entry of `backend/package.json`
and gets rolled into the bundle. The built backend therefore
contains the SDK whether or not anyone uses it.

Bundle-size cost: `@sentry/node` core is ~150–250 KB minified +
gzipped depending on integrations imported. Acceptable for the
APK/IPA but not zero. Mitigations:

- Subpath-import only what we need
  (`@sentry/node/init`, `@sentry/core`) rather than the full
  default bundle. We do **not** want HTTP / Express / undici
  auto-instrumentation in this Node — the only network surface
  is the local fastify on 127.0.0.1.
- Exclude OTLP exporters; the only transport we need is the
  Sentry HTTPS transport that ships in `@sentry/node`.
- Confirm rollup can tree-shake; if not, the bundle plugin
  config in `backend/rollup.config.ts` may need an explicit
  `external: []` adjustment.

A future optimisation if size matters more than build simplicity
(§9.2): produce a second backend bundle with Sentry stripped, and
have the native module pick which assets dir to copy into
`nodejs-project/` based on host-app config. Not in v1.

### 5.2 `Sentry.init()` location

In `backend/index.js`, before any other side-effecting import that
might throw and before `controlIpcServer.listen()`:

```js
// backend/index.js (sketch)
import * as Sentry from "@sentry/node";

let sentryActive = false;

function initSentry(config) {
  Sentry.init({
    dsn: config.dsn,
    environment: config.environment,
    release: config.release,
    sampleRate: config.sampleRate ?? 1.0,
    tracesSampleRate: config.tracesSampleRate ?? 0,
    integrations: [
      // Keep this list explicit — auto-discovery pulls in
      // http/express/etc. that we don't want.
      Sentry.consoleLoggingIntegration(),
    ],
    // tag every event so we can split JS vs native vs backend
    // in Sentry's UI.
    initialScope: { tags: { layer: "backend" } },
  });
  sentryActive = true;
}
```

The `init` handler in `controlIpcServer` calls `initSentry` if the
frame includes a `sentry` field, before resolving `initPromise`:

```js
init: (message) => {
  // … existing rootKey validation …
  if (message.sentry) {
    try { initSentry(message.sentry); }
    catch (e) { console.error("Sentry init failed", e); }
  }
  resolveInit(rootKey);
}
```

### 5.3 Error capture wiring

Three failure surfaces in `backend/index.js` to retrofit:

1. **`handleFatal(phase, error)`** — already the single funnel for
   uncaught exceptions, unhandled rejections, and boot-phase
   throws (`listen-control`/`init`/`construct`/`runtime`). Add:

   ```js
   if (sentryActive) {
     Sentry.captureException(err, {
       tags: { phase, layer: "backend" },
     });
     // Ensure the event is flushed before process.exit(1).
     await Sentry.flush(100).catch(() => {});
   }
   ```

   The 100 ms flush window aligns with the existing
   `broadcastError` flush — both run inside the same
   pre-exit window, in parallel.

2. **`error-native` handler** — frames forwarded from Android
   FGS-local failures (rootkey, watchdog) reach `handleFatal`
   with the FGS-supplied phase, so they get captured by #1
   automatically. We add a `tags: { source: "native" }` so
   Sentry can filter cross-process forwarding.

3. **Per-RPC errors** — handled in §5.4.

### 5.4 RPC tracing — server side

Replicates the `onRequestHook` from
`comapeo-mobile/src/backend/src/app.js`, called from
`backend/lib/comapeo-rpc.js`:

```js
// backend/lib/comapeo-rpc.js (sketch)
import * as Sentry from "@sentry/node";

export class ComapeoRpcServer extends ServerHelper {
  constructor(manager, { sentry } = {}) {
    super((socket) => {
      const messagePort = new SocketMessagePort(socket);
      messagePort.start();
      const server = createMapeoServer(manager, messagePort, {
        onRequestHook: sentry ? makeSentryRequestHook() : undefined,
      });
      messagePort.on("close", () => server.close());
    });
  }
}

function makeSentryRequestHook() {
  return (request, next) => {
    const sentryTrace = request.metadata?.["sentry-trace"];
    const baggage = request.metadata?.baggage;
    return Sentry.continueTrace({ sentryTrace, baggage }, () =>
      Sentry.startSpan(
        {
          op: "rpc",
          name: request.method.join("."),
          forceTransaction: true,
          attributes: {
            "rpc.method": request.method.join("."),
            // args intentionally omitted unless rpcArgsBytes>0
          },
        },
        async (span) => {
          try {
            await next(request);
            span.setStatus({ code: 1, message: "ok" });
          } catch (error) {
            span.setStatus({ code: 2, message: "internal_error" });
            Sentry.captureException(error, {
              tags: { layer: "backend", op: "rpc" },
            });
            throw error;
          }
        },
      ),
    );
  };
}
```

Differences from the comapeo-mobile reference:

- The hook is only registered when Sentry is active; absent
  config, `createMapeoServer` is called without
  `onRequestHook` and there is zero overhead.
- We rethrow after `captureException` so the IPC error path
  still returns a rejection to the JS caller. The reference
  swallows it inside `startSpan`'s callback, which silently
  resolves the RPC promise — that loses error visibility
  on the JS side.
- `request.args` is not serialized by default. In CoMapeo data
  the args can be project-scoped content (observation fields,
  attachments). PII risk is high, so opt-in only via
  `rpcArgsBytes`.

### 5.5 OpenTelemetry forwarding (PR #1051)

When `comapeo-core` PR #1051 merges, `@comapeo/core` will emit
OpenTelemetry spans through the global `@opentelemetry/api`
provider. `@sentry/node` v8+ is built on OpenTelemetry: spans
emitted via `@opentelemetry/api` are picked up automatically by
the Sentry span processor.

Concretely, after `Sentry.init()`, no further wiring is needed —
`@comapeo/core`'s spans become children of the active Sentry
transaction (the RPC span from §5.4) and ship to the configured
DSN.

If PR #1051 lands before this integration, we should verify the
parent span linkage in a manual smoke test (see §10).

---

## 6. JS / RN module instrumentation (`src/`)

### 6.1 New files

- `src/sentry.ts` — public sub-export. Exposes
  `configureSentry()`, types, and the wrapped client.
- `src/sentry-internal.ts` — module-private state holding the
  active adapter (or `null`), keyed reads for the RPC wrapper.

The main barrel (`src/index.ts`) is unchanged so consumers who
don't import the sub-export get no Sentry types or runtime code
linked in.

### 6.2 RPC client tracing — request side

The existing `comapeo` client is created once at module load:

```ts
// src/ComapeoCoreModule.ts:71-72
const messagePort = new CoreMessagePort() as unknown as MessagePort;
export const comapeo: MapeoClientApi = createMapeoClient(messagePort);
```

To attach `sentry-trace` + `baggage` headers as `request.metadata`
on outgoing RPC frames, we have two options:

**Option A — IPC-level metadata factory** (preferred)

`@comapeo/ipc/client.js` already supports `request.metadata` on
the wire (the server reads it in `onRequestHook`). If
`createMapeoClient` accepts (or can be extended to accept) a
`getMetadata(method)` option, we register one that returns the
current trace headers from the active Sentry adapter:

```ts
// src/ComapeoCoreModule.ts (changed)
import { activeAdapter } from "./sentry-internal";

export const comapeo: MapeoClientApi = createMapeoClient(messagePort, {
  getMetadata: () => {
    const a = activeAdapter();
    if (!a) return undefined;
    // Sentry v8 helper that returns sentry-trace + baggage.
    const { "sentry-trace": st, baggage } = a.getTraceData();
    return st ? { "sentry-trace": st, baggage } : undefined;
  },
});
```

Verify whether the installed `@comapeo/ipc` (currently `^8.0.0`)
exposes such a hook. If it doesn't, file an upstream issue and
fall back to Option B for the interim.

**Option B — Method proxy wrapper**

`configureSentry` returns a Proxy-wrapped clone of `comapeo`
where each method call:
1. Starts a `Sentry.startSpan({ op: "rpc.client", name: ... })`.
2. Reads `getTraceData()` for headers.
3. Calls the underlying `comapeo` method with a wrapped first
   argument that smuggles the headers — but this only works if
   the IPC supports per-call metadata, which collapses Option B
   into Option A.

If neither path is possible without an upstream change to
`@comapeo/ipc`, we accept JS-side spans without distributed
tracing for v1 (the backend still produces its own spans, just
unlinked) and pursue the IPC change as a follow-up.

### 6.3 State observer capture

`state` already surfaces every error condition the JS layer
sees. `configureSentry()` registers two listeners:

```ts
state.addListener("stateChange", (s, info) => {
  if (s !== "ERROR" || !info) return;
  const e = new Error(info.errorMessage);
  e.name = `ComapeoError:${info.errorPhase}`;
  adapter.captureException(e, {
    tags: {
      layer: "rn",
      "comapeo.phase": info.errorPhase,
      "comapeo.state": s,
    },
  });
});

state.addListener("messageerror", (err) => {
  adapter.captureException(err, {
    tags: { layer: "rn", source: "control-socket" },
    level: "warning",
  });
});
```

Phase tags align with the values produced in
`src/ComapeoCore.types.ts` and the native sources
(`rootkey`, `node-runtime-unexpected`, `shutdown-timeout`,
`starting-timeout`, `ipc`, `listen-control`, `init`,
`construct`, `runtime`). They become Sentry filterable tags so
the team can dashboard "rootkey load failure rate" or "FGS
watchdog timeout rate" without parsing message strings.

### 6.4 Public client error capture

The IPC client surfaces RPC errors as rejected promises. Most
captures happen on the backend side (§5.4) and reach Sentry from
there with full context. The JS side adds a thin
`captureException` for client-perceived errors (e.g. RPC timeouts,
disconnect mid-call) that the backend never observed:

```ts
// inside the wrapper or proxy from §6.2
async (...args) => {
  return Sentry.startSpan({ op: "rpc.client", name: method }, async () => {
    try {
      return await underlying[method](...args);
    } catch (e) {
      // Only capture if it didn't originate from a backend
      // event we already see in §5.4 — the backend tags its
      // captures with `layer: "backend"`. Backend RPC failures
      // arrive here as plain errors, but Sentry de-dupes if
      // the same exception is captured twice with different
      // contexts. Acceptable.
      Sentry.captureException(e, {
        tags: { layer: "rn", op: "rpc.client", "rpc.method": method },
      });
      throw e;
    }
  });
}
```

---

## 7. Native instrumentation (`ios/`, `android/`)

The host app's `@sentry/react-native` already configures the
underlying `sentry-cocoa` and `sentry-android` SDKs for the main
process. What's left for this module:

### 7.1 Forwarding the backend Sentry config

A new bridge method on the Expo module:

- iOS: `ComapeoCoreModule.swift::Function("setSentryConfig", …)`
  → calls `nodeService.setSentryConfig(json)`.
- Android (main app process): same function, forwards the JSON
  to the FGS via an Intent extra on `startService`.

The `NodeJSService` on each platform stores the JSON and
embeds it in the `init` frame (§4.2).

### 7.2 Android FGS process

The FGS runs in the `:ComapeoCore` process — see
`ARCHITECTURE.md §2.2`. `Sentry.init()` in the host app's
`MainApplication` runs only in the main process; the FGS process
gets a fresh `Application` and needs its own init.

Two options:

1. **Host-app responsibility.** Document that the host app's
   `MainApplication.onCreate` should detect the FGS process and
   call `SentryAndroid.init(...)` with the same DSN there.
   `@sentry/react-native` does not handle multi-process
   automatically.
2. **Module convenience.** Add a helper
   `ComapeoCoreInit.installSentryInFgs(application, options)` that
   the host calls from its `MainApplication`. The helper detects
   `getProcessName().endsWith(":ComapeoCore")` and conditionally
   inits `SentryAndroid`.

Option 2 keeps the cross-process detail inside the module that
introduced the second process. Recommended.

### 7.3 Native error tagging

When `NodeJSService` enters ERROR locally (rootkey load,
watchdog), it already populates `_lastError` and emits
`stateChange`. The module emits a JS-visible event that §6.3
captures, but on Android FGS that capture happens in the main
process — the FGS's own context (logcat tail, foreground state,
notification ID) is in the *FGS* process's Sentry scope.

If the FGS-side Sentry SDK is initialised (§7.2 option 2), we
also call `SentryAndroid.captureException` from the FGS error
handler, tagged `proc:fgs phase:<phase>`, before we forward the
`error-native` frame to Node. The duplicate event (FGS-side +
backend-side via `error-native` re-broadcast + main-process JS-side
via `stateChange`) is deduplicated by Sentry's fingerprinting and
gives us all three vantage points.

iOS doesn't need this — the FGS doesn't exist there, everything
runs in the host app process and the host app's
`@sentry/react-native` already covers it.

### 7.4 Hard-crash reporting

Crashes that bypass JS (SIGSEGV in a native addon, OOM kill,
`process.abort()`) are documented in `ARCHITECTURE.md §6` as
"belong in a separate channel". `sentry-cocoa` and
`sentry-android` already handle native crashes for the host app
process; on Android the FGS process needs its own init (§7.2)
to capture FGS-process crashes.

We do not bundle `sentry-native` into the embedded `nodejs-mobile`
runtime. A V8 abort or libnode crash will not produce a Sentry
event from inside Node — but it will produce an Android-process
crash (since the FGS process dies) which `sentry-android` will
capture with a stacktrace from the JNI side.

---

## 8. PII, sampling, and privacy

CoMapeo data is sensitive (observation locations, attachments,
device identities). Defaults must avoid leaking it into Sentry:

- **`request.args` is never serialized** unless
  `rpcArgsBytes > 0` is explicitly set. Method names and
  metadata only.
- **No project IDs in span names**; only RPC method paths
  (`project.observation.create`, etc.). If we later want
  per-project breakdowns, hash the project ID before adding
  it as a tag.
- **No rootkey, no public/secret keypair, no observation
  contents** in event payloads. The `error-native` frame
  carries phase + message; the backend `Sentry.captureException`
  call does too.
- **Stacktraces** are fine — they may include filenames from
  inside `@comapeo/core` and the bundled backend. No user data
  unless an `Error.message` was constructed with one (audit
  these on integration).
- **`tracesSampleRate`** defaults to `0` if unspecified. The
  host app must opt into RPC tracing volume explicitly.
- **`sendDefaultPii`** (Sentry option) is left to the host
  app's `Sentry.init()` and the backend init we forward; we
  don't override it.

A pre-merge checklist (§10) includes a `before_send` hook that
greps every outbound event for known sensitive substrings
(`rootKey`, `dsn`, base64-shaped 22-char strings) as a
defense-in-depth check during integration smoke tests.

---

## 9. Phasing

### 9.1 Phase 1 — error capture only (smallest delivery)

- `configureSentry({ sentry, backend: null })` valid: only
  JS-side errors via `state` listeners (§6.3). No backend
  changes, no IPC changes, no bundle delta.
- Ship as `@comapeo/core-react-native/sentry` sub-export.
- Host app (CoMapeo Mobile) calls it after `Sentry.init`.

Value: immediate visibility into rootkey failures, watchdog
timeouts, IPC errors, and `messageerror` parse failures —
the most actionable production failures we have today.

Cost: ~50 LOC in `src/sentry.ts`, no native or backend
changes, zero risk to other consumers.

### 9.2 Phase 2 — backend error capture + RPC tracing

- Add `@sentry/node` to `backend/package.json`, bundle it.
- Extend `init` frame with optional `sentry` field.
- `handleFatal` and `onRequestHook` wired (§5.3, §5.4).
- iOS/Android `setSentryConfig` bridge methods (§7.1).
- Client-side `getMetadata` (§6.2) for distributed tracing
  (or accept JS-side spans without parent linkage if
  `@comapeo/ipc` doesn't yet support it — track upstream).

Value: RPC method-level errors and durations in Sentry;
backend boot failures with proper stacktraces; baseline
distributed tracing.

Cost: ~200 LOC across backend, JS, and native; ~150–250 KB
bundle delta on every consumer (mitigations in §5.1).

### 9.3 Phase 3 — Android FGS-process Sentry

- `installSentryInFgs(application, options)` helper (§7.2).
- Document the multi-process init pattern in README.

Value: FGS-process hard crashes and FGS-local errors get
process-tagged Sentry events with FGS-context breadcrumbs.

### 9.4 Phase 4 — `@comapeo/core` OpenTelemetry forwarding

- Bump `@comapeo/core` once PR #1051 lands.
- Verify Sentry's OTel integration picks up the spans
  with the RPC transaction as parent.
- Document any required tracing-config overrides.

Value: deep traces inside core operations (sync, indexing,
hypercore) — the data Sentry's performance tab is designed
to surface.

### 9.5 Phase 5 — refinements

- Tune sample rates from production data.
- Add structured breadcrumbs for state transitions (so
  pre-error context shows the boot sequence).
- Optional: dual backend bundles for Sentry-free consumers
  if bundle size becomes a concern.

---

## 10. Test plan

### 10.1 Unit / integration

- `src/sentry.ts` accepts a fake adapter; assert
  `captureException` is called for synthetic ERROR
  `stateChange` events with the correct phase tag.
- `src/sentry.ts` is a no-op if `configureSentry` was never
  called: the existing `comapeo` client should produce
  identical wire frames (no `metadata` injected).
- Backend: build the bundle without a `sentry` field in
  `init` and confirm `Sentry.init` is never called.
  Build with the field and confirm `onRequestHook` is
  registered (assert via metadata propagation).

### 10.2 Manual smoke

- Run the example app with a temporary DSN (a test Sentry
  project). Trigger:
  - A deliberate JS-side throw inside a `comapeo.*` callback
    → JS-layer event in Sentry.
  - A backend throw via a debug RPC method → backend-layer
    event with parent transaction.
  - An Android FGS rootkey-store corruption (delete the
    keystore alias) → ERROR event with `phase:rootkey`
    from both FGS-process and main-process scopes.
  - A node abort (`process.abort()` via a debug RPC) →
    `sentry-android` native crash event.
- Confirm no PII in events: open each event, scan for
  base64-shaped 22-char strings, file paths under
  `Application Support`, project secrets.
- Confirm distributed trace shows JS-client span → backend
  RPC transaction → (with PR #1051) core operation spans.

### 10.3 Regression

- Run the existing `e2e/run-instrumented-tests.sh` and the
  iOS `swift test` / `xcodebuild test` suite with
  `configureSentry` *not* called → no behaviour change.
- Build size delta tracked: compare `android/src/main/assets/nodejs-project/`
  bundle size before and after Phase 2.

---

## 11. Open questions

1. **Does `@comapeo/ipc@^8` support a client-side `getMetadata`
   hook?** §6.2 hinges on this. If not, what's the upstream
   path — patch + release, or temporary monkey-patch in this
   module?
2. **Sentry SDK version**: pin to `@sentry/react-native@^6` and
   `@sentry/node@^8`? The OpenTelemetry-first model only exists
   in v8+ for Node and v6+ for React Native; older versions
   force a different tracing API.
3. **Bundle size budget**: do we have a hard limit for the
   embedded backend? §5.1 estimates suggest ~150–250 KB; if the
   budget is tighter, plan for dual bundles in Phase 5.
4. **Release tagging**: how does `release` flow from the host
   app (CoMapeo Mobile) into the backend? The natural source is
   the host app's `package.json` version, but the backend bundle
   is built inside this module — we'd need to surface the value
   via the runtime config rather than baking it in at build time.
5. **Cross-process scope on Android**: Phase 3 assumes the FGS's
   Sentry events can carry a `proc:fgs` tag. Confirm the host
   app's `@sentry/react-native` config doesn't override our tag
   in the main-process events.

---

## 12. Summary of file changes

Concrete touch list, by phase, for code review.

**Phase 1**

- `src/sentry.ts` (new) — `configureSentry`, types, state listeners.
- `src/sentry-internal.ts` (new) — module-private adapter holder.
- `package.json` — add `@sentry/react-native` to `peerDependencies`
  with `peerDependenciesMeta.optional: true`.
- `docs/sentry-integration-plan.md` (this file).

**Phase 2**

- `backend/package.json` — `@sentry/node` dependency.
- `backend/index.js` — `initSentry`, hook `handleFatal`, extend
  `init` handler.
- `backend/lib/comapeo-rpc.js` — accept `sentry` option, register
  `onRequestHook`.
- `src/ComapeoCoreModule.ts` — pass `getMetadata` to
  `createMapeoClient` (or wrapper fallback).
- `ios/ComapeoCoreModule.swift`, `ios/NodeJSService.swift` —
  `setSentryConfig` and embed in `init` frame.
- `android/src/main/java/com/comapeo/core/ComapeoCoreModule.kt`,
  `NodeJSService.kt` — same on Android, plus FGS Intent extra.

**Phase 3**

- `android/src/main/java/com/comapeo/core/ComapeoCoreInit.kt`
  (new) — FGS-side Sentry init helper.
- README — document FGS init pattern for host apps.

**Phase 4**

- `backend/package.json` — bump `@comapeo/core` once PR #1051
  ships.
- Smoke test verification, no code changes expected.

---
