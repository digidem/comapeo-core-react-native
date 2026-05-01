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
  inside the bundle. Configuration is read at native process start
  from build-time-baked sources (Android manifest meta-data, iOS
  Info.plist) seeded by an Expo config plugin (§4.2), and forwarded
  to the backend in the existing `init` control-socket frame. This
  avoids any JS round-trip on the boot path so the FGS can
  cold-start without RN being alive.
- **Android FGS process** has no JS bridge but does reach the
  same Sentry-android SDK if the host app's `MainApplication`
  initializes it before starting the FGS. Cross-process attribution
  is via `release`+`environment`+a `proc:fgs` tag, not a shared
  client.

---

## 4. Configuration

### 4.0 The cold-start constraint

Earlier drafts of this plan plumbed the backend Sentry config from
JS through the control-socket `init` frame. That has a real cost:

1. **FGS cold-start (Android).** The `:ComapeoCore` foreground
   service can be cold-launched by the system to deliver a sync
   trigger *before* the host app's RN bridge is alive. With a
   JS-driven config, the FGS would have to either start the
   backend with Sentry off (losing observability for the most
   interesting code path — boot-time errors during a cold sync)
   or block on RN to come up first (defeats the purpose of an
   FGS-survives-RN architecture).
2. **Boot latency on every launch.** Even when RN is alive, the
   JS round-trip for `setSentryConfig(...)` adds a serial step
   to the boot sequence. The backend can't sample `boot.listen`
   or `boot.construct` spans until after RN is ready and has
   called `configureSentry`.
3. **State observability gap.** `state.getState()` reflects only
   transitions captured *after* the JS listener is attached.
   Errors that fire before `configureSentry` runs (rootkey load
   races, FGS-side watchdog timeouts) miss Sentry entirely under
   the JS-driven model.

Three configuration vectors solve this together:

| Vector | When read | Purpose |
|---|---|---|
| **Expo config plugin** (build-time) | At native process start, before any IPC | DSN, environment, release, sample rates. The single source of truth. |
| **Persisted native preference** (runtime, restart-to-activate) | At native process start | The "capture application data" toggle (§9). |
| **JS adapter handoff** (`configureSentry`) | When RN bridge is up | Hands the host app's already-initialized `@sentry/react-native` to this module so JS-side listeners can call `captureException` / `startSpan`. Does **not** carry DSN. |

### 4.1 Build-time: Expo config plugin (primary)

A new plugin shipped from this module — `app.plugin.js` at the
package root, registered in `expo-module.config.json`. It uses
the same `@expo/config-plugins` patterns already in use for
`apps/example/plugins/with-android-tests/index.js`.

Consumer registration in CoMapeo Mobile's `app.json` /
`app.config.ts`:

```json
{
  "expo": {
    "plugins": [
      [
        "@comapeo/core-react-native",
        {
          "sentry": {
            "dsn": "https://abc@sentry.example.com/1",
            "environment": "production",
            "release": "1.4.2",
            "tracesSampleRate": 0.1,
            "rpcArgsBytes": 0
          }
        }
      ]
    ]
  }
}
```

The plugin runs at `expo prebuild` and writes:

**Android — `<application>` meta-data in `AndroidManifest.xml`** via
`withAndroidManifest`:

```xml
<meta-data android:name="com.comapeo.core.sentry.dsn"
    android:value="https://abc@sentry.example.com/1"/>
<meta-data android:name="com.comapeo.core.sentry.environment"
    android:value="production"/>
<meta-data android:name="com.comapeo.core.sentry.release"
    android:value="1.4.2"/>
<meta-data android:name="com.comapeo.core.sentry.tracesSampleRate"
    android:value="0.1"/>
<meta-data android:name="com.comapeo.core.sentry.rpcArgsBytes"
    android:value="0"/>
```

These meta-data live on the manifest's main `<application>` tag so
**both the main process and the `:ComapeoCore` FGS process see
them** — `PackageManager.getApplicationInfo(...).metaData` is
shared across processes within the package.

**iOS — keys in `Info.plist`** via `withInfoPlist`:

```xml
<key>ComapeoCoreSentryDsn</key>
<string>https://abc@sentry.example.com/1</string>
<key>ComapeoCoreSentryEnvironment</key>
<string>production</string>
<key>ComapeoCoreSentryRelease</key>
<string>1.4.2</string>
<key>ComapeoCoreSentryTracesSampleRate</key>
<string>0.1</string>
<key>ComapeoCoreSentryRpcArgsBytes</key>
<string>0</string>
```

Plugin behaviour rules:

- If the consumer registers the plugin without a `sentry` key, no
  meta-data / Info.plist entries are written. Native treats the
  absence as "Sentry off". The example app under `apps/example/`
  ships unconfigured.
- If the consumer registers the plugin **with** a `sentry` key,
  exactly the keys provided are written. Missing optional fields
  (e.g. `environment`) result in absent manifest entries, which
  native maps to `null` in the loaded `SentryConfig`.
- Plugin code is small (~50 LOC) and lives alongside the existing
  `app.plugin.js` patterns. The plugin is consumed at `expo
  prebuild` time only — runtime code path doesn't touch it.
- The DSN is now embedded in the host app's APK/IPA. That's an
  accepted tradeoff: Sentry DSNs are not high-secret values
  (they identify a project, not authenticate writes; rate
  limiting and per-project ingest are server-side). They appear
  in stripped binaries of every Sentry-using app.

### 4.2 Native config consumption

At native process start (FGS `onCreate` on Android, app delegate
init on iOS), the module loads the manifest / plist keys into a
typed `SentryConfig?` and propagates it two ways:

```kotlin
// android/.../SentryConfigStore.kt (new) — sketch
data class SentryConfig(
  val dsn: String,
  val environment: String?,
  val release: String?,
  val sampleRate: Double?,
  val tracesSampleRate: Double?,
  val rpcArgsBytes: Int?,
)

fun loadFromManifest(ctx: Context): SentryConfig? {
  val meta = ctx.packageManager.getApplicationInfo(
    ctx.packageName, PackageManager.GET_META_DATA
  ).metaData ?: return null
  val dsn = meta.getString("com.comapeo.core.sentry.dsn") ?: return null
  return SentryConfig(
    dsn = dsn,
    environment = meta.getString("com.comapeo.core.sentry.environment"),
    release = meta.getString("com.comapeo.core.sentry.release"),
    sampleRate = meta.getString("com.comapeo.core.sentry.sampleRate")?.toDoubleOrNull(),
    tracesSampleRate = meta.getString("com.comapeo.core.sentry.tracesSampleRate")?.toDoubleOrNull(),
    rpcArgsBytes = meta.getString("com.comapeo.core.sentry.rpcArgsBytes")?.toIntOrNull(),
  )
}
```

The loaded `SentryConfig` is consumed in two places:

1. **Native SDK init (Android FGS process).** `SentryAndroid.init(ctx)
   { options -> options.dsn = config.dsn; ... }` in the FGS
   `Application.onCreate`. Allows the FGS process to capture native
   crashes, ANRs, and the §7.4 telemetry events with the same DSN.
   On iOS the host app's `@sentry/react-native` already owns the
   single-process SDK; we don't re-init.
2. **Backend init frame.** When `NodeJSService.sendInit(rootKey)`
   builds the `init` frame, it embeds `SentryConfig` as a
   `sentry` field (see §4.5). The backend `Sentry.init()`s
   synchronously inside the existing `init` handler, before
   `MapeoManager` is constructed and before
   `ComapeoRpcServer.listen` registers `onRequestHook`. No JS
   round-trip; the FGS-cold-start path is fully covered.

This is the key change vs. the prior draft: **the backend boot
sequence does not depend on RN being alive to be observable**.

### 4.3 JS adapter handoff

JS-side listeners (§6) need a callable Sentry object — `startSpan`,
`captureException`, `getTraceData`. Because the host app already
runs `Sentry.init()` from `@sentry/react-native` (which reads the
same Info.plist / manifest values via its own auto-config),
`configureSentry` exists purely to hand that initialized client
to this module:

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
  | "addBreadcrumb"
>;

export interface ComapeoSentryConfig {
  /**
   * The host app's already-initialized `@sentry/react-native`
   * (or any object satisfying `SentryAdapter`). The module
   * never calls `Sentry.init()`; the host app does, and the
   * native SDK is initialized from manifest/plist values
   * written by the config plugin.
   */
  sentry: SentryAdapter;
}

/**
 * Hand off the host app's Sentry adapter so this module's JS
 * listeners can call into it. Idempotent and one-shot.
 *
 * Must be called before the first `comapeo.*` RPC if you want
 * client-side spans on those calls. State observers attach
 * immediately on call.
 *
 * Note: this does NOT configure DSN/environment/release. Those
 * are baked into native config at build time by the Expo plugin
 * and read by both `@sentry/react-native` (in the main process)
 * and the embedded backend (in the FGS or iOS app process).
 */
export function configureSentry(config: ComapeoSentryConfig): void;
```

Consumer usage in CoMapeo Mobile:

```ts
import * as Sentry from "@sentry/react-native";
import { configureSentry } from "@comapeo/core-react-native/sentry";

// Sentry SDK reads DSN from Info.plist / manifest; the plugin
// wrote those values at build time.
Sentry.init({ /* override options if needed */ });

configureSentry({ sentry: Sentry });
```

Apps that don't want Sentry don't import the sub-export and don't
register the plugin. The main barrel
(`@comapeo/core-react-native`) keeps no Sentry imports; the only
typecheck-time pull-in for opt-in consumers is the
`SentryAdapter` type.

### 4.4 Runtime opt-in toggle (forward reference)

A persisted "capture application data" boolean lives in native
preferences. It gates the *additional* observability surface
described in §7.4 (per-RPC method spans, sync session spans,
counts) but never touches DSN/environment/release and never
unlocks PII fields. See §9 for full design.

### 4.5 Control-socket payload (internal)

For completeness — the `init` frame written by native to the
backend now carries an optional `sentry` field:

```js
// Native → Node, on control.sock
{
  type: "init",
  rootKey: "<base64>",
  sentry: {
    dsn: "https://…",
    environment: "production",
    release: "1.4.2",
    sampleRate: 1.0,
    tracesSampleRate: 0.1,
    rpcArgsBytes: 0,
    captureApplicationData: false   // §9 toggle, snapshot at boot
  }
}
```

The backend `init` handler (`backend/index.js`) calls
`initSentry(message.sentry)` before resolving `initPromise`. The
DSN is therefore short-lived in process memory only; not in argv,
not in env, not on disk past the manifest read.

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

### 7.1 Loading config and forwarding to the backend

Native reads `SentryConfig` from the manifest / Info.plist
(§4.2) at process start. There is no JS bridge call required;
config is in place before RN can boot.

- **iOS**: `AppLifecycleDelegate.application(_:didFinishLaunchingWithOptions:)`
  reads `Bundle.main.infoDictionary` and stores `sentryConfig` on
  `NodeJSService` before `runNode()`.
- **Android (FGS)**: `ComapeoCoreService.onCreate` reads
  `packageManager.getApplicationInfo(...).metaData` and stores
  `sentryConfig` on `NodeJSService` before `start()`.
- **Android (main process)**: reads the same metaData when the
  `ComapeoCoreModule` first instantiates, used only for the
  control-IPC observer to add §7.4 breadcrumbs/events from the
  main process. The main-process Sentry SDK is already
  initialized by `@sentry/react-native` reading the same values
  via its own pathway — we don't re-init.

The stored config is embedded in the `init` frame
(§4.5) when `NodeJSService.sendInit(rootKey)` runs. The
runtime opt-in toggle (§9) is read from native preferences at the
same moment and merged into the same payload.

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

### 7.3 Native error tagging — see §7.4.7

The cross-process error attribution detail moved into §7.4.7
alongside the rest of the native telemetry data design.

### 7.4 Native telemetry data design

This is the heart of the native instrumentation. Sentry has a
small set of primitives, each suited to different kinds of data.
We design the captures around them rather than dumping logs:

| Sentry primitive | Use for | Example |
|---|---|---|
| **Breadcrumb** | Lightweight ordered context — what led up to an event. Cheap, capped at ~100 by default, attached to the next event. | "state STARTING→STARTED at t+312ms", "ipc connected", "FGS notification posted" |
| **Transaction** (root span) | A timed unit of work with a clear start/end and a name. Indexed; dashboards can chart durations and counts. | `comapeo.boot` (start→started), `comapeo.shutdown` (stop→stopped) |
| **Span** (child) | A nested timed sub-step inside a transaction. | `boot.listen-control`, `boot.init`, `boot.construct`, `boot.ipc-connect` |
| **Event** (`captureMessage` / `captureException`) | A discrete error or notable occurrence; full stacktrace + context. | rootkey load failure, watchdog timeout fired, FGS killed by OS |
| **Tag** | Indexed key/value pair on events — used for dashboard filtering. | `phase:rootkey`, `proc:fgs`, `comapeo.state:ERROR`, `platform:android` |
| **Context** (custom) | Structured but non-indexed — appears on event detail pages. | `{"comapeo": {"abi": "arm64-v8a", "nodejs_mobile_version": "...", "ipc_socket_age_ms": 1234}}` |
| **User** (anonymized) | A stable but non-identifying user/session id. | host-app-supplied install ID; never the rootkey |

The remainder of this section walks through what each layer of
the native architecture (state machine, boot phases, timeouts,
IPC, FGS lifecycle) maps onto.

#### 7.4.1 State transitions → breadcrumbs

Every `ComapeoState` transition (`STOPPED`/`STARTING`/`STARTED`/
`STOPPING`/`ERROR`) is captured as a breadcrumb on both the
FGS-side and main-process Sentry scopes:

```kotlin
// android/.../NodeJSService.kt (FGS), inside the state-derivation
// callsite that already runs deriveState(...)
Sentry.addBreadcrumb(Breadcrumb().apply {
  category = "comapeo.state"
  level = if (newState == STARTED || newState == STOPPED)
            SentryLevel.INFO
          else if (newState == ERROR)
            SentryLevel.ERROR
          else SentryLevel.INFO
  message = "$oldState → $newState"
  setData("from", oldState.name)
  setData("to", newState.name)
  setData("backendState", backendState.javaClass.simpleName)
  setData("nodeRuntime", nodeRuntime.javaClass.simpleName)
  setData("stopRequested", stopRequested)
})
```

These never trigger an upload by themselves — they ride along
on the next event. When something does fire (an ERROR transition,
a captured exception), the dashboard shows the last ~30 seconds of
state history leading up to it. That's exactly the data needed
to debug "why did this end up in ERROR" questions. Always-on.

#### 7.4.2 Boot as a transaction with phase spans

Boot is the single most error-prone path in the system. We model
it as a Sentry transaction that spans from `start()` to either
`STARTED` or `ERROR`:

```
Transaction: comapeo.boot (op = "boot")
├─ Span: boot.listen-control
├─ Span: boot.ipc-connect (control)
├─ Span: boot.rootkey-load                   (FGS only)
├─ Span: boot.init (rootkey handshake)
├─ Span: boot.construct (MapeoManager + RPC bind)
└─ Span: boot.ipc-connect (comapeo)
```

Each phase corresponds to a stage already named in
`backend/index.js` (the catch tags `phase` on errors with these
exact strings). On the native side, each phase is bracketed by
the existing log calls — we just add `Sentry.startSpan` around
them. Phases that throw set the span status to `internal_error`
and capture the exception; phases that succeed set `ok`.

The transaction is **always-on essential telemetry**: durations
at boot are first-class signal for performance regressions
(rootkey load took 2s instead of 50ms? new device security
hardware quirk). Native sample rate is independent of
`tracesSampleRate` — we sample boot at 100% even when
`tracesSampleRate=0.01` for RPC because boot fires once per
process and is high-value. Implemented via
`Sentry.startSpan({ ..., forceTransaction: true })` and a
dedicated boot-tag inspected by an event processor that lifts
its sample rate to 1.0.

#### 7.4.3 Shutdown as a transaction

Symmetric: `comapeo.shutdown` transaction from `stop()` to
final `STOPPED` (or `ERROR` if shutdown timed out). Spans
for `shutdown.broadcast-stopping`, `shutdown.close-rpc`,
`shutdown.node-join`. Surfaces the difference between graceful
shutdowns (under the 10 s budget) and watchdog-killed ones.

#### 7.4.4 Timeouts → events (always)

Every timeout enumerated in `ARCHITECTURE.md §5.7` becomes a
Sentry event when it fires, tagged with which timeout it was:

| Timeout | Sentry shape | Tags |
|---|---|---|
| iOS `startupTimeout` (30s) | `captureMessage("comapeo: startup timeout fired")` `level=error` | `timeout:startup, platform:ios, layer:native` |
| iOS `stop(timeout:)` | `captureMessage("comapeo: stop timeout fired")` `level=warning` | `timeout:shutdown, platform:ios` |
| iOS `waitForFile` | `captureMessage("comapeo: waitForFile timeout")` `level=error` | `timeout:waitForFile, socket:<comapeo|control>` |
| iOS `connectWithRetry` exhausted | event with `attempts` context | `timeout:connectRetry` |
| Android `startupTimeoutMs` (30s) | `captureMessage(...)` `level=error` | `timeout:startup, platform:android, proc:fgs` |
| Android FGS `withTimeout` (10s) on stop | `captureMessage(...)` `level=error` | `timeout:fgsStop, proc:fgs` |
| Android `SEND_ERROR_NATIVE_TIMEOUT_MS` (2s) | breadcrumb + `level=warning` event | `timeout:errorNativeForward` |
| Android `waitForFile` (30s) | `captureMessage(...)` `level=error` | `timeout:waitForFile` |

Timeouts are the most actionable signal for "something is
silently broken" — they always fire something we never want
to pre-emptively recover from. Always-on essential telemetry.

#### 7.4.5 IPC connection lifecycle → breadcrumbs + events

`NodeJSIPC.State` transitions
(`Connecting`/`Connected`/`Disconnecting`/`Disconnected`/`Error`)
become breadcrumbs at `category: "comapeo.ipc"`. Disconnects from
a `Connected` state in non-stopping conditions also fire an
event tagged `ipc.unexpected_disconnect:true` with the
pre-disconnect JS state — that's the path that derives `ERROR`
phase `node-runtime-unexpected` (`ARCHITECTURE.md §5.4`),
useful to surface separately from controlled disconnects.

#### 7.4.6 FGS lifecycle → breadcrumbs

Android-only: the `ComapeoCoreService` lifecycle hooks
(`onCreate`, `onStartCommand`, `onTaskRemoved`, `onDestroy`) and
notification post/cancel become breadcrumbs at
`category: "comapeo.fgs"`. FGS-killed-by-OS scenarios (the FGS
process dies without `onDestroy` running) appear in
`sentry-android`'s session-replay-style detection if it's
enabled — we don't add custom code for that.

#### 7.4.7 Native error tagging (was §7.3)

When `NodeJSService` enters ERROR locally (rootkey load,
watchdog), it already populates `_lastError` and emits
`stateChange`. The JS-visible capture happens in §6.3, but on
Android FGS that capture lands in the *main* process — the
FGS's own context (logcat tail, foreground state, notification
ID) is in the *FGS* process's Sentry scope.

If the FGS-side Sentry SDK is initialised (§4.2), we also call
`Sentry.captureException` from the FGS error handler, tagged
`proc:fgs phase:<phase>`, **before** forwarding the
`error-native` frame to Node. The duplicate event (FGS-side +
backend-side via `error-native` re-broadcast + main-process
JS-side via `stateChange`) is deduplicated by Sentry's
fingerprinting; the three captures together carry the FGS
context, the backend stack, and the main-process state-machine
trail.

iOS doesn't need this — the FGS doesn't exist there, everything
runs in the host app process and the host app's
`@sentry/react-native` already covers it.

#### 7.4.8 Categorization: essential vs opt-in

| Capture | Tier | Rationale |
|---|---|---|
| State transition breadcrumbs | **Essential** | Cheap, ride on existing events. Required to debug ERROR paths. |
| Boot transaction + phase spans | **Essential** | Once-per-process, high-value perf signal. Forced 100% sample. |
| Shutdown transaction + phase spans | **Essential** | Same reasoning — once-per-process. |
| Timeout events | **Essential** | Always actionable; never silent recovery. |
| ERROR `captureException` (FGS, backend, main) | **Essential** | Already fires; this plan just structures it. |
| IPC connection breadcrumbs | **Essential** | Cheap; required to attribute disconnect-derived ERROR. |
| Unexpected-disconnect event | **Essential** | High-signal failure mode. |
| FGS lifecycle breadcrumbs | **Essential** | Cheap; required to debug FGS-killed-by-OS scenarios. |
| Per-RPC method spans (sampled) | **Opt-in** (capture application data on) | High volume; usable for performance dashboards but only when the user consented. |
| Sync session transaction (start → ready → finish, with peer count) | **Opt-in** | Reveals usage cadence. Counts only — no peer identities. |
| Background/foreground transitions | **Opt-in** | Reveals usage patterns. |
| Backend memory/heap snapshots (periodic) | **Opt-in** | Cost is non-trivial; only needed for memory-leak hunts. |
| Storage size of `privateStorageDir` (periodic) | **Opt-in** | Dataset-size signal. |

#### 7.4.9 Hard never-capture list

Independent of any toggle, these are off by construction —
not behind a config option, not behind `rpcArgsBytes>0`, not
ever:

- The 16-byte rootkey, in any encoding.
- Identity public/secret keypairs derived from the rootkey.
- Observation contents (text, attachments, attachment paths).
- Precise location (lat/lng). If we ever want geographic
  distribution data, it goes through quantization to
  ~country/region resolution at the host-app layer, never
  here.
- User-entered text from any settings UI.
- Project IDs in raw form. If included as a tag, must be
  hashed (SHA-256, truncated to 16 chars) at capture site.
- Peer device identities or discovered peer counts above
  bucketed thresholds (e.g. record `peers_bucket: 1-3 / 4-10 / 10+`,
  not raw counts).
- File paths under `Application Support` or
  `getFilesDir()` that include the rootkey or project IDs.

A `before_send` event processor enforces the list
defensively: it walks the event tree for known sensitive
substrings (`rootKey`, base64-shaped 22-char strings, `lat=`,
`lng=`, `latitude:`, `longitude:`) and either redacts or
drops the event. This is belt-and-suspenders — the fix is
always at the capture site, but the processor catches
mistakes before they ship.

### 7.5 Hard-crash reporting

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

## 9. Runtime "capture application data" toggle

A persisted boolean preference, off by default, that the host
app's settings UI exposes to the end user. When on, the
**opt-in** captures from §7.4.8 are emitted; when off (the
default), only the essential captures are. Crucially, this
never unlocks anything in the §7.4.9 never-capture list — the
two layers are independent.

### 9.1 Persistence

A native preference, written and read entirely on the native
side so it survives app uninstall-resistant in the same way
existing user prefs do (and is not a special concern at the
backup/restore layer):

- **Android**: stored in
  `EncryptedSharedPreferences("comapeo-core-prefs", ...)` —
  the same `androidx.security.crypto` mechanism used elsewhere
  in the module. Key: `sentry.captureApplicationData`. Read by
  both the main process and the FGS process.
- **iOS**: stored in `UserDefaults.standard` keyed
  `com.comapeo.core.sentry.captureApplicationData`. Read at
  app delegate init.

### 9.2 JS API

The toggle is exposed alongside `configureSentry`:

```ts
// File: src/sentry.ts (additions)
/**
 * Read the persisted opt-in flag. Resolves with the
 * current native-side value. Reads are sync-fast on both
 * platforms but the API is async to match the bridge.
 */
export function getCaptureApplicationData(): Promise<boolean>;

/**
 * Write the persisted opt-in flag. Returns when the write has
 * been durably committed on the native side.
 *
 * IMPORTANT: the new value does NOT take effect until the next
 * app launch. The current process keeps emitting whatever it
 * was emitting at boot. This is documented in the host app's
 * settings UI so the user knows to restart for the change to
 * apply.
 */
export function setCaptureApplicationData(enabled: boolean): Promise<void>;
```

### 9.3 Why restart-to-activate

Two reasons:

1. **Snapshot-at-boot semantics.** The flag's value is read
   once, at process start, and embedded in the `init` frame
   to the backend (`captureApplicationData: bool`). The
   backend wires its `onRequestHook`, OTel sampler, and
   custom span emitters based on that snapshot. Hot-toggling
   would mean re-registering hooks on a live RPC server,
   which adds a class of bugs (in-flight requests with one
   instrumentation, new requests with another) for marginal
   value.
2. **Predictable user expectation.** The user toggling
   "capture more data for debugging" should reasonably
   expect a clear before/after, not a partial transition
   in the middle of an active sync session.

A minor cost: if the user has an active issue right now, they
need to flip the toggle and restart the app to start
collecting. The host-app UI says exactly that.

### 9.4 What the toggle gates

When `captureApplicationData == true`, the following turn on
in addition to the essential set:

- **Per-RPC client + server spans.** `tracesSampleRate`
  effectively goes from 0 → its configured value (default
  0.1). Method names only; never args. Span attributes
  include `rpc.method`, `rpc.status`, `rpc.duration_ms`.
- **Sync session lifecycle transaction.** A
  `comapeo.sync.session` transaction from `connectPeers`
  (or first peer-connected event) through to
  `syncFinished`/`disconnect`. Spans inside for
  `discover`, `handshake`, `replicate`. Counts only:
  number of peers (bucketed), bytes transferred (bucketed),
  duration. **No peer identities, no project IDs in raw
  form.**
- **Background/foreground transitions** — host-app `pause`
  and `resume` events become `comapeo.app.background` /
  `comapeo.app.foreground` breadcrumbs that ride on
  subsequent events, helping correlate timing
  ("error fired 3s after app backgrounded").
- **Backend memory checkpoint.** Once at `STARTED` and
  every 60s thereafter, a custom context entry on the
  next event with `process.memoryUsage()` snapshot
  (rss, heapTotal, heapUsed). No event capture by
  itself — context only.
- **`privateStorageDir` size sample.** Once at `STARTED`,
  the on-disk size of dbFolder + indexFolder + customMaps
  as a numeric `du`-style integer. Bucketed (`<10MB`,
  `10–100MB`, `100MB–1GB`, `>1GB`) before sending to
  avoid leaking the exact size of a sensitive dataset.

### 9.5 Plumbing path

```
[user toggles in app settings]
        │
        ▼
setCaptureApplicationData(true)        ─── JS ───
        │
        ▼
ComapeoCoreModule.setCaptureApplicationData  ─── Native bridge ───
        │
        ▼
EncryptedSharedPreferences write (Android)    ─── Persisted ───
UserDefaults.set (iOS)
        │
        ▼
[user is told: restart required]

============= NEXT LAUNCH =============

NodeJSService starts        ─── Native ───
        │
        ▼
read EncryptedSharedPreferences / UserDefaults
        │
        ▼
sentryConfig.captureApplicationData = true
        │
        ▼
embed in init frame to backend       ─── Control socket ───
        │
        ▼
backend initSentry({captureApplicationData})    ─── Node ───
        │
        ▼
- onRequestHook registered (per-RPC spans)
- sync-session emitter registered
- memory-snapshot timer started
- tracesSampleRate raised to configured value
```

### 9.6 What the toggle never unlocks

The §7.4.9 never-capture list applies regardless. Specifically:

- The toggle does not raise `rpcArgsBytes` from 0; raw RPC
  args remain off. (`rpcArgsBytes` is a separate **build-time**
  config-plugin option for developer debug builds.)
- The toggle does not start capturing observation contents.
- The toggle does not start capturing precise location.
- The toggle does not start capturing peer identities.

If a future requirement wants any of those, it lands as a
*separate*, more-restrictive opt-in (and likely never ships
to production at all).

### 9.7 Default and migration

Default value when the preference has never been written:
`false`. We never auto-enable. A user upgrading the app to a
version that introduces this toggle starts at `false` and only
enters extended capture when they explicitly flip the switch.

---

## 10. Phasing

### 10.1 Phase 1 — JS-side error capture (smallest delivery)

- `configureSentry({ sentry })` adapter handoff (§4.3).
- `state` listeners capture ERROR transitions and
  `messageerror` events via `@sentry/react-native` (§6.3).
- Ship as `@comapeo/core-react-native/sentry` sub-export.
- Host app (CoMapeo Mobile) calls `Sentry.init` itself.

Value: immediate visibility into rootkey failures, watchdog
timeouts, IPC errors, and `messageerror` parse failures —
provided RN is alive when they fire. (The FGS-cold-start gap
is closed in Phase 2.)

Cost: ~50 LOC in `src/sentry.ts`, no native or backend
changes, zero risk to other consumers.

### 10.2 Phase 2 — Expo config plugin + native config consumption

- New `app.plugin.js` at module root (§4.1).
- iOS reads Info.plist into `SentryConfig` at app delegate
  init; Android reads manifest meta-data at FGS `onCreate`.
- Native error tagging (§7.4.7) and FGS-side
  `SentryAndroid.init` from manifest values.
- State-transition breadcrumbs and boot transaction
  (§7.4.1, §7.4.2) wired into the existing
  `NodeJSService` state-derivation callsites.
- Timeout events (§7.4.4) on the existing watchdog firing
  paths.

Value: native-side error capture is live for production users
without depending on RN being alive. FGS cold-start path is
fully observable. Boot durations dashboarded.

Cost: ~150 LOC native (Kotlin + Swift), ~50 LOC plugin, no
backend changes yet.

### 10.3 Phase 3 — backend error capture + RPC tracing

- Add `@sentry/node` to `backend/package.json`, bundle it.
- Extend `init` frame with optional `sentry` field (§4.5).
- `handleFatal` and `onRequestHook` wired (§5.3, §5.4).
- Client-side `getMetadata` (§6.2) for distributed tracing
  (or accept JS-side spans without parent linkage if
  `@comapeo/ipc` doesn't yet support it — track upstream).

Value: RPC method-level errors and durations in Sentry;
backend boot failures with proper stacktraces; baseline
distributed tracing.

Cost: ~200 LOC across backend, JS, and native; ~150–250 KB
bundle delta on every consumer (mitigations in §5.1).

### 10.4 Phase 4 — `@comapeo/core` OpenTelemetry forwarding

- Bump `@comapeo/core` once PR #1051 lands.
- Verify Sentry's OTel integration picks up the spans
  with the RPC transaction as parent.
- Document any required tracing-config overrides.

Value: deep traces inside core operations (sync, indexing,
hypercore) — the data Sentry's performance tab is designed
to surface.

### 10.5 Phase 5 — capture-application-data toggle

- Native preference store (Android `EncryptedSharedPreferences`,
  iOS `UserDefaults`) with `getCaptureApplicationData` /
  `setCaptureApplicationData` JS API (§9.2).
- Read on boot, embed in `init` frame, gates the §7.4.8 opt-in
  captures (per-RPC method spans, sync session transaction,
  background/foreground breadcrumbs, memory checkpoints,
  storage size sample).
- `before_send` privacy processor (§7.4.9 enforcement).

Value: opt-in detailed observability for users who consent,
useful for performance investigations and usage-pattern
debugging without exposing PII.

Cost: ~150 LOC native + JS + backend.

### 10.6 Phase 6 — refinements

- Tune sample rates from production data.
- Optional: dual backend bundles for Sentry-free consumers
  if bundle size becomes a concern.

---

## 11. Test plan

### 11.1 Unit / integration

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
- Config plugin: snapshot test that running the plugin with
  a `sentry` argument writes the expected manifest
  meta-data and Info.plist keys. Run without argument →
  no entries written.
- Native config store: synthetic manifest / plist with
  partial keys decode into `SentryConfig` with `null` for
  missing optional fields; total absence returns `null`.
- Native breadcrumb emission: drive `NodeJSService` through a
  scripted state-machine sequence and assert the breadcrumbs
  posted to a fake Sentry SDK match the expected shape and
  level mapping.
- Toggle persistence: write `setCaptureApplicationData(true)`,
  read it back, kill the process, read it back again — value
  survives. Re-launch and confirm the flag flows into the
  init frame.
- `before_send` privacy processor: feed it events containing
  base64-shaped strings, latitude/longitude markers, and raw
  project IDs; assert each is redacted or dropped.

### 11.2 Manual smoke

- Run the example app with a temporary DSN (a test Sentry
  project) configured via the plugin. Trigger:
  - A deliberate JS-side throw inside a `comapeo.*` callback
    → JS-layer event in Sentry.
  - A backend throw via a debug RPC method → backend-layer
    event with parent transaction.
  - An Android FGS rootkey-store corruption (delete the
    keystore alias) → ERROR event with `phase:rootkey`
    from both FGS-process and main-process scopes, with
    state-transition breadcrumbs in the trail.
  - A node abort (`process.abort()` via a debug RPC) →
    `sentry-android` native crash event.
  - Force the FGS startup watchdog to fire (e.g. by
    blocking `initPromise` in a test build) → timeout
    event with `timeout:startup` tag.
  - **FGS cold-start path**: from a freshly-killed app
    state, trigger an FGS-only launch (background sync
    intent) without bringing RN up. Verify boot
    transaction lands in Sentry from the FGS process
    alone.
- Toggle "capture application data" on, restart, and run
  a scripted sync session. Confirm `comapeo.sync.session`
  transaction appears with bucketed peer count and no
  raw peer identities. Toggle off, restart, and confirm
  the transaction stops appearing.
- Confirm no PII in events: open each event, scan for
  base64-shaped 22-char strings, file paths under
  `Application Support`, project secrets.
- Confirm distributed trace shows JS-client span → backend
  RPC transaction → (with PR #1051) core operation spans.

### 11.3 Regression

- Run the existing `e2e/run-instrumented-tests.sh` and the
  iOS `swift test` / `xcodebuild test` suite with
  `configureSentry` *not* called → no behaviour change.
- Build size delta tracked: compare `android/src/main/assets/nodejs-project/`
  bundle size before and after Phase 2.

---

## 12. Open questions

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
6. **Release tagging via plugin**: §4.1 has the consumer pass
   `release` as a literal in `app.json`. CoMapeo Mobile likely
   wants this auto-derived from the host app's version. The
   plugin can read `config.version` (the consumer's `expo.version`)
   as a default; a `${VERSION}` placeholder is another option.
   Decide which.
7. **Plugin output for empty config**: when the consumer
   registers the plugin without a `sentry` argument (e.g. just
   `["@comapeo/core-react-native"]`), the plugin should be a
   no-op for Sentry. Confirm we don't accidentally write empty
   `<meta-data>` entries that confuse the native loader.
8. **Toggle UI surface**: where does the host app expose the
   `setCaptureApplicationData` switch? CoMapeo Mobile already
   has a settings screen — coordinate the copy and restart
   prompt. Out of scope for this module but called out for
   integration.
9. **Boot transaction sample rate**: §7.4.2 forces 100% on boot
   even when overall `tracesSampleRate` is low. Confirm this
   doesn't blow Sentry quota for high-launch-volume users.
   May need a 1-in-N sampler with a minimum floor.
10. **`EncryptedSharedPreferences` for the toggle**: it's
    stronger than necessary for a non-sensitive boolean. Plain
    `SharedPreferences` would be simpler and faster. Decision
    pending unless we want the toggle's value masked from
    on-device tooling, which seems unnecessary.

---

## 13. Summary of file changes

Concrete touch list, by phase, for code review.

**Phase 1**

- `src/sentry.ts` (new) — `configureSentry`, types, state listeners.
- `src/sentry-internal.ts` (new) — module-private adapter holder.
- `package.json` — add `@sentry/react-native` to `peerDependencies`
  with `peerDependenciesMeta.optional: true`.
- `docs/sentry-integration-plan.md` (this file).

**Phase 2 — Expo plugin + native config + breadcrumbs/spans**

- `app.plugin.js` (new, module root) — `withAndroidManifest` to
  inject `<meta-data>` and `withInfoPlist` to inject keys.
- `expo-module.config.json` — register the plugin if needed
  (the file is already wired to expo-modules via this manifest).
- `ios/SentryConfigStore.swift` (new) — read Info.plist into
  `SentryConfig`.
- `android/src/main/java/com/comapeo/core/SentryConfigStore.kt`
  (new) — read manifest meta-data into `SentryConfig`.
- `ios/AppLifecycleDelegate.swift` — read config and stash on
  `NodeJSService` before `runNode()`.
- `ios/NodeJSService.swift` — accept stored config, embed in
  init frame.
- `android/src/main/java/com/comapeo/core/ComapeoCoreService.kt`
  — read config in `onCreate`, init `SentryAndroid` for the
  FGS process, pass to `NodeJSService`.
- `android/src/main/java/com/comapeo/core/NodeJSService.kt`,
  `ios/NodeJSService.swift` — add `Sentry.addBreadcrumb` calls
  on every state-derivation update; wrap boot phases in
  `Sentry.startSpan`; emit timeout events.
- `android/src/main/java/com/comapeo/core/ComapeoCoreModule.kt`
  (main process) — same breadcrumb/event emission from the
  control-IPC observer.

**Phase 3 — backend instrumentation**

- `backend/package.json` — `@sentry/node` dependency.
- `backend/index.js` — `initSentry`, hook `handleFatal`, extend
  `init` handler validation.
- `backend/lib/comapeo-rpc.js` — accept `sentry` option, register
  `onRequestHook`.
- `src/ComapeoCoreModule.ts` — pass `getMetadata` to
  `createMapeoClient` (or wrapper fallback).

**Phase 4 — OpenTelemetry forwarding**

- `backend/package.json` — bump `@comapeo/core` once PR #1051
  ships.
- Smoke test verification, no code changes expected.

**Phase 5 — capture-application-data toggle**

- `android/src/main/java/com/comapeo/core/SentryPrefsStore.kt`
  (new) — `EncryptedSharedPreferences` read/write of the
  toggle, plus `getCaptureApplicationData` /
  `setCaptureApplicationData` bridge.
- `ios/SentryPrefsStore.swift` (new) — `UserDefaults`
  equivalent.
- `android/.../ComapeoCoreModule.kt`, `ios/ComapeoCoreModule.swift`
  — Expo bridge `Function` entries for the two methods.
- `src/sentry.ts` — JS exports `getCaptureApplicationData`,
  `setCaptureApplicationData`.
- `backend/lib/comapeo-rpc.js` — wire `tracesSampleRate`
  conditionally on the toggle; register sync-session emitter
  only when on.
- `backend/index.js` — accept `captureApplicationData` in
  init payload; gate memory-checkpoint timer and storage
  sampling.
- `backend/before-send.js` (new) — `before_send` privacy
  processor (the §7.4.9 redaction belt-and-suspenders).

---
