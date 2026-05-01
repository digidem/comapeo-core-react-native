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
│                            │ argv: --sentryDsn, --sentry...,      │
│                            │       --captureApplicationData       │
│                            │ comapeo.sock RPC (with sentry-trace) │
│                            ▼                                      │
│    ┌─────────────────── Node backend ─────────────────┐           │
│    │  loader.mjs                                      │           │
│    │   - parseArgs → if DSN: Sentry.init() then       │           │
│    │     await import('./index.mjs')                  │           │
│    │   - lazy chunk: @sentry/node loaded only on opt-in           │
│    │  index.mjs                                       │           │
│    │   - handleFatal → captureException               │           │
│    │   - createMapeoServer({ onRequestHook }) → spans │           │
│    │   - OpenTelemetry processor sends @comapeo/core  │           │
│    │     spans (PR #1051) to Sentry transport         │           │
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

Plugin inputs:

| Field | Required | Source |
|---|---|---|
| `dsn` | yes | App-specific Sentry project DSN. |
| `environment` | yes | Build-environment label (e.g. `development`, `qa`, `production`). The consumer decides the scheme. |
| `release` | no, defaults to versionName | If omitted, native reads `versionName` (Android) / `CFBundleShortVersionString` (iOS) at runtime. |
| `tracesSampleRate` | no | Sentry sampling knob. |
| `sampleRate` | no | Sentry sampling knob. |
| `rpcArgsBytes` | no | RPC arg-truncation cap (developer debug builds only). |

The module deliberately **does not derive `environment`** —
build-environment schemes are app-specific. CoMapeo Mobile's
frontend uses an `applicationId` suffix mapping
(`.dev`/`.rc`/`.pre`) in `src/frontend/lib/appVariant.ts`, but
that's a CoMapeo convention, not something other consumers of
this module should be locked into.

Instead, the consumer feeds `environment` from a build-time
source they control. The cleanest path on EAS is **`eas.json`
build-profile env vars + `app.config.js`** so the same
codebase produces different `environment` values for
internal/test/release builds. CoMapeo Mobile's
`eas.json` would carry:

```json
{
  "build": {
    "development": {
      "env": {
        "SENTRY_DSN": "https://…",
        "SENTRY_ENVIRONMENT": "development"
      }
    },
    "preview": {
      "env": {
        "SENTRY_DSN": "https://…",
        "SENTRY_ENVIRONMENT": "qa"
      }
    },
    "production": {
      "env": {
        "SENTRY_DSN": "https://…",
        "SENTRY_ENVIRONMENT": "production"
      }
    }
  }
}
```

…and `app.config.js` (must be `.js`, not `app.json`, to read
`process.env`):

```js
// app.config.js
export default {
  expo: {
    plugins: [
      ["@comapeo/core-react-native", {
        sentry: {
          dsn: process.env.SENTRY_DSN,
          environment: process.env.SENTRY_ENVIRONMENT ?? "production",
        },
      }],
    ],
  },
};
```

EAS evaluates `app.config.js` with the build profile's `env`
visible as `process.env.*`, so each `eas build --profile X`
bakes a different `environment` string into the manifest /
plist at prebuild time. No native code change between profiles.

`release` is the one value we *do* default from existing native
config: omitting it makes the native loader fall back to
`versionName` / `CFBundleShortVersionString` — the canonical
versions Expo and the host app are already using. Consumers can
still pass `release` explicitly (e.g. to embed a git SHA from
EAS's `EAS_BUILD_GIT_COMMIT_HASH`) and the explicit value wins.

The plugin runs at `expo prebuild` and writes:

**Android — `<application>` meta-data in `AndroidManifest.xml`** via
`withAndroidManifest`:

```xml
<meta-data android:name="com.comapeo.core.sentry.dsn"
    android:value="https://abc@sentry.example.com/1"/>
<meta-data android:name="com.comapeo.core.sentry.environment"
    android:value="production"/>
<meta-data android:name="com.comapeo.core.sentry.tracesSampleRate"
    android:value="0.1"/>
<meta-data android:name="com.comapeo.core.sentry.rpcArgsBytes"
    android:value="0"/>
<!-- release omitted: native falls back to versionName -->
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
<key>ComapeoCoreSentryTracesSampleRate</key>
<string>0.1</string>
<key>ComapeoCoreSentryRpcArgsBytes</key>
<string>0</string>
<!-- release omitted: native falls back to CFBundleShortVersionString -->
```

Plugin behaviour rules:

- If the consumer registers the plugin without a `sentry` key, no
  meta-data / Info.plist entries are written. Native treats the
  absence as "Sentry off". The example app under `apps/example/`
  ships unconfigured.
- If the consumer registers the plugin **with** a `sentry` key, the
  plugin validates that `dsn` and `environment` are present
  (throwing at prebuild time if they're not — fast failure beats
  a silently-misconfigured Sentry project) and writes the
  corresponding meta-data / plist keys. Optional fields
  (`release`, `tracesSampleRate`, `sampleRate`, `rpcArgsBytes`)
  are written only when provided.
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
  val environment: String,
  val release: String,
  val sampleRate: Double?,
  val tracesSampleRate: Double?,
  val rpcArgsBytes: Int?,
)

fun loadFromManifest(ctx: Context): SentryConfig? {
  val meta = ctx.packageManager.getApplicationInfo(
    ctx.packageName, PackageManager.GET_META_DATA
  ).metaData ?: return null
  val dsn = meta.getString("com.comapeo.core.sentry.dsn") ?: return null

  // Environment: written by the plugin from the consumer's
  // app.config.js, which sources it from EAS build-profile env
  // (see §4.1). Required when a DSN is present — the plugin
  // refused to prebuild without it, so this should never be
  // null at runtime; treat null as a build misconfiguration.
  val environment = meta.getString("com.comapeo.core.sentry.environment")
    ?: error("comapeo: sentry.environment missing from manifest")

  // Release: prefer plugin override, else fall back to the
  // host app's versionName — the canonical source of truth,
  // same value expo-application reports.
  val release = meta.getString("com.comapeo.core.sentry.release")
    ?: ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName
    ?: "unknown"

  return SentryConfig(
    dsn = dsn,
    environment = environment,
    release = release,
    sampleRate = meta.getString("com.comapeo.core.sentry.sampleRate")?.toDoubleOrNull(),
    tracesSampleRate = meta.getString("com.comapeo.core.sentry.tracesSampleRate")?.toDoubleOrNull(),
    rpcArgsBytes = meta.getString("com.comapeo.core.sentry.rpcArgsBytes")?.toIntOrNull(),
  )
}
```

iOS reads the same key set from `Bundle.main.infoDictionary`
(`ComapeoCoreSentryDsn`, `ComapeoCoreSentryEnvironment`, etc.) and
falls back to `CFBundleShortVersionString` for `release` if the
plist key was absent.

There is intentionally **no native-side derivation logic** for
`environment`. Build-environment schemes are app-specific —
this module reads whatever literal string the consumer's plugin
wrote, with no coupling to any particular `applicationId` suffix
convention.

The loaded `SentryConfig` is consumed in two places:

1. **Native SDK init (Android FGS process).** `SentryAndroid.init(ctx)
   { options -> options.dsn = config.dsn; ... }` in the FGS
   `Application.onCreate`. Allows the FGS process to capture native
   crashes, ANRs, and the §7.4 telemetry events with the same DSN.
   On iOS the host app's `@sentry/react-native` already owns the
   single-process SDK; we don't re-init.
2. **Backend, via Node argv at spawn time.** Native serializes
   `SentryConfig` (plus the §9 `captureApplicationData` toggle)
   into argv and passes it to `nodejs-mobile`'s start call. The
   backend's `loader.mjs` entry parses argv, runs `Sentry.init()`,
   then dynamically imports `index.mjs`. See §5.1 for the bundle
   layout and §5.2 for the loader pattern.

This is the key change vs. the prior draft: **Sentry config
flows through argv, not through the control-socket `init`
frame**. The init frame stays focused on the rootkey (which we
deliberately keep out of argv per `ARCHITECTURE.md §7.4`). The
DSN is fine in argv: it's already in the manifest of every
Sentry-using app's APK/IPA, identifies a project rather than
authenticating writes, and is rate-limited server-side.

The benefits stack:

- **FGS cold-start**: Sentry config is in native config + argv;
  Node boots with full instrumentation before RN is alive.
- **Auto-instrumentation order**: `Sentry.init()` runs in
  `loader.mjs` *before* the dynamic import of `index.mjs`, so
  OpenTelemetry's `import-in-the-middle` patches modules as
  they load. This is the explicit pattern from comapeo-mobile's
  `src/backend/loader.js`.
- **Lazy bundle chunk**: when the manifest has no DSN, native
  doesn't pass `--sentryDsn=...` in argv; the loader's
  `if (sentryDsn) await import('@sentry/node')` short-circuits
  and the rollup-split `@sentry/node` chunk never loads.

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

### 4.5 Backend transport: argv at Node spawn

Native already passes positional argv to the Node process when
it spawns nodejs-mobile (`comapeoSocketPath`, `controlSocketPath`,
`privateStorageDir`; see `backend/index.js:19-20`). We extend
that with named flags for Sentry config, mirroring
comapeo-mobile's pattern (`src/frontend/initializeNodejs.ts`):

```
node loader.mjs \
  <comapeoSocketPath> <controlSocketPath> <privateStorageDir> \
  --sentryDsn=https://abc@sentry.example.com/1 \
  --sentryEnvironment=production \
  --sentryRelease=1.4.2 \
  --sentryTracesSampleRate=0.1 \
  --sentryRpcArgsBytes=0 \
  --captureApplicationData      # only when toggle is on
```

Native picks the loader path (`loader.mjs`) as the entry script
and constructs the argv from `SentryConfig` plus the §9
toggle's persisted value. When the manifest has no DSN, the
`--sentry*` flags are omitted entirely; the loader's first
check is `if (!sentryDsn) await import('./index.mjs')` — no
`@sentry/node` chunk is ever loaded.

The control-socket `init` frame stays focused on the rootkey
(unchanged from today, except optional sibling fields are now
gone):

```js
// Native → Node, on control.sock
{ type: "init", rootKey: "<base64>" }
```

Why argv is the right transport for Sentry config (and not the
rootkey):

| | Sentry config | Rootkey |
|---|---|---|
| Already in app binary? | Yes (manifest / plist) | No (encrypted in keystore) |
| Server-side rate limited? | Yes | n/a — single bytes are the secret |
| Visible in `/proc/<pid>/cmdline`? | Yes | Would be — that's the problem |
| Needed before any other module loads? | **Yes** (auto-instrumentation order) | No (received post-handshake) |
| Right transport | argv | init frame |

Argv satisfies the auto-instrumentation order requirement:
`Sentry.init()` must run before any module that Sentry wants
to patch is imported. The control-socket init frame arrives
*after* `index.js` has already imported `@comapeo/core`,
`fastify`, and friends; argv is the only transport that
arrives before the loader's first import.

---

## 5. Backend instrumentation (`backend/`)

Mirrors `comapeo-mobile/src/backend/src/app.js`, adapted to this
module's two-socket boot.

### 5.1 Bundle strategy: multi-entry with lazy `@sentry/node` chunk

The backend currently rolls into a single `index.mjs` per
platform (see `backend/rollup.config.ts`). To support
auto-instrumentation **and** keep the bundle weight off
non-Sentry consumers, we move to the multi-entry layout used by
`comapeo-mobile/src/backend/rollup.config.js`:

```
nodejs-project/
├── loader.mjs          # spawn target — parses argv, optionally
│                       #   inits Sentry, then dynamically imports
│                       #   index.mjs.
├── index.mjs           # current entry — unchanged in shape; now
│                       #   imported dynamically by the loader.
├── importHook.js       # OpenTelemetry's import-in-the-middle
│                       #   hook entry. MUST be a separate file
│                       #   because it's loaded with module.register(),
│                       #   not import. Empty/unused when Sentry isn't
│                       #   active.
├── lib/register.js     # Internal dep of import-in-the-middle that
│                       #   it expects at this exact relative path.
│                       #   Bundled as its own chunk and copied
│                       #   across; can't be inlined.
└── chunks/sentry-*.mjs # Auto-emitted rollup chunk holding
                        #   @sentry/node + transitive deps. Loaded
                        #   only when loader.mjs awaits the dynamic
                        #   import.
```

**Why each piece is separate**:

- **`loader.mjs`** is the new spawn target. Native passes
  `loader.mjs` to nodejs-mobile instead of `index.mjs`.
  The loader parses `--sentryDsn`/etc. from `process.argv`,
  dynamically imports `@sentry/node` if a DSN is present,
  calls `Sentry.init()`, then `await import('./index.mjs')`.
  This is the comapeo-mobile pattern verbatim — without the
  init-before-other-imports order, Sentry's OpenTelemetry
  auto-instrumentation can't patch modules.
- **`importHook.js`** is `import-in-the-middle/hook.mjs`,
  which OpenTelemetry registers as a Node module-loading
  hook via `module.register('import-in-the-middle/hook.mjs', ...)`.
  `module.register` requires a **separate file** that is
  loaded fresh in a child loader thread; it can't be
  bundled into the same module that calls
  `module.register`. The comapeo-mobile rollup config
  carries this as a dedicated entry; we do the same.
- **`lib/register.js`** is a sub-dep of `import-in-the-middle`
  that resolves via a hard-coded relative path
  (`./lib/register.js`). Cannot be bundled. Comapeo-mobile
  carries this too — we mirror.
- **`chunks/sentry-*.mjs`** is what rollup auto-emits when it
  sees `await import('@sentry/node')` in the loader and the
  rest of the bundle never touches it statically. Output
  format is `format: 'esm'`; rollup with
  `output.manualChunks` (or default code-splitting) produces
  the chunk. Consumers who don't pass `--sentryDsn` never
  load this chunk; the cost is install-time disk only.

**Path-rewrite plugin**. The
`rollup-plugin-import-hook.mjs` from comapeo-mobile rewrites
calls like
`module.register('import-in-the-middle/hook.mjs', …)` to
`module.register('./importHook.js', …)` so the runtime
register call points at the bundled output rather than the
node_modules path that no longer exists post-bundle. We port
this plugin into `backend/rollup-plugins/`.

**Updated `backend/rollup.config.ts` shape** (sketch):

```ts
import importHook from "./rollup-plugins/rollup-plugin-import-hook.mjs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const sharedInput = {
  loader: path.join(__dirname, "loader.mjs"),
  index:  path.join(__dirname, "index.js"),
  // Required separate chunks for import-in-the-middle:
  importHook:    require.resolve("import-in-the-middle/hook.mjs"),
  "lib/register": require.resolve("import-in-the-middle/lib/register.js"),
};

// In buildPlugins: append importHook() alongside the existing
// addonLoaderPlugin() / esmShim() / nodeResolve() pipeline.
```

**Bundle-size cost**:

- Consumers **with** Sentry: ~150–250 KB extra in the
  per-platform output dir (the sentry chunk plus `importHook` /
  `lib/register`). Loaded into V8 only when DSN is present.
- Consumers **without** Sentry: same disk cost (the chunks
  ship in `nodejs-project/`), but **zero runtime cost**: the
  `@sentry/node` chunk is never required by any path the
  loader executes when `--sentryDsn` is absent. The loader
  itself is tiny (~1 KB) and runs unconditionally.

If install size becomes the bottleneck (it currently isn't —
the existing `nodejs-project/` tree is dominated by V8 + native
addons), Phase 6 adds a second backend bundle with the Sentry
chunks stripped at build time, and `scripts/build-backend.ts`
selects which to copy based on whether the consumer's
`app.json` registered the plugin with a DSN. Not in v1.

**Sentry rollup plugin (sourcemaps).** Comapeo-mobile uses
`@sentry/rollup-plugin` to upload sourcemaps for stack-trace
symbolication. We add the same to `backend/rollup.config.ts`
behind `process.env.SENTRY_AUTH_TOKEN` — only runs in CI for
release builds, no-op otherwise. Sourcemap upload is the only
way Sentry can map minified backend stack frames back to
readable JS.

### 5.2 `loader.mjs` — `Sentry.init()` and dynamic import

```js
// backend/loader.mjs (new) — sketch, mirroring
// comapeo-mobile/src/backend/loader.js

import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    sentryDsn:               { type: "string" },
    sentryEnvironment:       { type: "string" },
    sentryRelease:           { type: "string" },
    sentryTracesSampleRate:  { type: "string" },
    sentrySampleRate:        { type: "string" },
    sentryRpcArgsBytes:      { type: "string" },
    captureApplicationData:  { type: "boolean", default: false },
  },
  // The three positional args (comapeoSocketPath, controlSocketPath,
  // privateStorageDir) flow through unchanged for index.mjs to read.
  allowPositionals: true,
  strict: false,
});

if (values.sentryDsn) {
  // Dynamic import so the rollup chunk only loads when needed.
  // Sentry.init() must complete before index.mjs imports anything,
  // because OpenTelemetry's import-in-the-middle hook can only
  // patch modules loaded after init.
  const Sentry = await import("@sentry/node");
  Sentry.init({
    dsn: values.sentryDsn,
    environment: values.sentryEnvironment ?? "production",
    release: values.sentryRelease,
    sampleRate: Number(values.sentrySampleRate ?? 1.0),
    tracesSampleRate: values.captureApplicationData
      ? Number(values.sentryTracesSampleRate ?? 0.1)
      : 0,
    integrations: [
      Sentry.consoleLoggingIntegration(),
    ],
    initialScope: { tags: { layer: "backend" } },
  });

  // Stash the parsed config so index.mjs can read it back
  // (RPC arg-truncation cap, capture-application-data toggle,
  // etc.) without re-parsing argv.
  globalThis.__comapeoSentryConfig = {
    rpcArgsBytes: Number(values.sentryRpcArgsBytes ?? 0),
    captureApplicationData: values.captureApplicationData,
  };
}

// Always run the app, with or without Sentry.
await import("./index.mjs");
```

**Order matters**: `Sentry.init()` runs before
`await import('./index.mjs')`. Inside `index.mjs`, the existing
top-level imports (`Fastify`, `@comapeo/core`, etc.) execute in
the patched module loader — Sentry's OpenTelemetry hook
intercepts each one and applies its instrumentation. If we
flipped the order, none of those modules would be patched.

**No-op path**. If `--sentryDsn` is absent, the `if (values.sentryDsn)`
block is skipped entirely, the `await import('@sentry/node')` is
never reached, the rollup-emitted Sentry chunk is never loaded,
and `index.mjs` runs identically to today. Zero overhead for
unconfigured consumers.

**Sentry's instrumentation patching nuances** (from
comapeo-mobile experience):

- The `consoleLoggingIntegration` requires `debug` to call
  `console.log` directly. The comapeo-mobile loader rebinds
  `debug.log = (...args) => console.log(...)` for non-production
  environments to make `debug('mapeo:*')` output flow through
  Sentry breadcrumbs. We replicate when `debug` is in our
  bundle (it's a transitive dep of `@comapeo/core`).
- The default Sentry transport hits the network synchronously
  on flush. For mobile we likely want
  `sentry-offline-transport-better-sqlite` (which comapeo-mobile
  uses) to queue events when offline. Folded into Phase 3
  if we ship offline transport, otherwise events are lost
  while offline (acceptable for v1).
- `Sentry.consoleLoggingIntegration({ levels: ["error"] })`
  in production keeps log volume sane; widening to
  `["error", "warn", "log"]` in dev mirrors comapeo-mobile.

### 5.3 `index.mjs` — read parsed config, no Sentry init

`backend/index.js` (renamed `index.mjs` for the multi-entry
layout) gets a small read of `globalThis.__comapeoSentryConfig`
for the RPC hook + toggle flags it needs. It does **not** call
`Sentry.init()` (that already happened in the loader) and the
control-socket `init` frame no longer carries any `sentry`
field:

```js
// backend/index.js (sketch — minimal additions)
import * as Sentry from "@sentry/node"; // resolved if loader ran init; otherwise unused

const sentryConfig = globalThis.__comapeoSentryConfig;
const sentryActive = sentryConfig != null;

// ... existing code unchanged ...

// In ComapeoRpcServer construction (§5.5):
comapeoRpcServer = new ComapeoRpcServer(comapeo, {
  sentry: sentryActive ? Sentry : null,
  rpcArgsBytes: sentryConfig?.rpcArgsBytes ?? 0,
  captureApplicationData: sentryConfig?.captureApplicationData ?? false,
});
```

When the loader didn't init Sentry, `import * as Sentry from "@sentry/node"`
in `index.mjs` would normally still load the chunk. To keep
the lazy behaviour intact, we use one of two patterns:

1. **Conditional import inside `index.mjs`**:
   ```js
   const Sentry = sentryActive ? await import("@sentry/node") : null;
   ```
   The chunk is only loaded if the loader already loaded it
   (cached in Node's module registry). Net: still zero work
   for the no-Sentry path.
2. **Adapter object on globalThis**: the loader stashes
   `globalThis.__comapeoSentry = Sentry` after init, and
   `index.mjs` reads from globalThis instead of importing.
   No further chunk-load risk.

Pick (2) for simplicity — `index.mjs` never names
`@sentry/node` at all, and the rollup chunk is unambiguously
gated by the loader's argv check.

### 5.4 Error capture wiring

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

3. **Per-RPC errors** — handled in §5.5.

### 5.5 RPC tracing — server side

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

### 5.6 OpenTelemetry forwarding (PR #1051)

When `comapeo-core` PR #1051 merges, `@comapeo/core` will emit
OpenTelemetry spans through the global `@opentelemetry/api`
provider. `@sentry/node` v8+ is built on OpenTelemetry: spans
emitted via `@opentelemetry/api` are picked up automatically by
the Sentry span processor.

Concretely, after `Sentry.init()`, no further wiring is needed —
`@comapeo/core`'s spans become children of the active Sentry
transaction (the RPC span from §5.5) and ship to the configured
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
captures happen on the backend side (§5.5) and reach Sentry from
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
      // event we already see in §5.5 — the backend tags its
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

- **Android**: stored in plain
  `SharedPreferences("comapeo-core-prefs", MODE_PRIVATE)`. Key:
  `sentry.captureApplicationData`. Read by both the main process
  and the FGS process. (The earlier draft considered
  `EncryptedSharedPreferences`; for a non-sensitive boolean
  there's no value in the encryption overhead, and plain prefs
  are cross-process-safe via `MODE_MULTI_PROCESS` if both
  processes need the live value — though the toggle is only
  read at process start so even that's unnecessary.)
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
SharedPreferences write (Android)             ─── Persisted ───
UserDefaults.set (iOS)
        │
        ▼
[user is told: restart required]

============= NEXT LAUNCH =============

NodeJSService starts        ─── Native ───
        │
        ▼
read persisted toggle (SharedPreferences / UserDefaults)
        │
        ▼
spawn Node with argv:
  loader.mjs <…sockets…> --sentryDsn=… [--captureApplicationData]
        │
        ▼
loader.mjs parseArgs                         ─── Node argv ───
        │
        ▼
Sentry.init({ tracesSampleRate: toggle ? 0.1 : 0, … })
globalThis.__comapeoSentryConfig = { captureApplicationData: true }
        │
        ▼
await import('./index.mjs')                  ─── Node ───
        │
        ▼
- onRequestHook registered (per-RPC spans)
- sync-session emitter registered
- memory-snapshot timer started
- (tracesSampleRate already set in Sentry.init)
```

Note that the toggle is read **once** at native process start
and passed as a Node argv flag (`--captureApplicationData`).
The control-socket `init` frame doesn't carry it. Restart-to-
activate is the natural consequence: the loader's argv is
fixed for the life of the Node process.

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

### 10.3 Phase 3 — backend loader + RPC tracing

- Add `@sentry/node`, `import-in-the-middle`, and
  `@sentry/rollup-plugin` to `backend/package.json`.
- Restructure `backend/rollup.config.ts` for multi-entry
  output (`loader`, `index`, `importHook`, `lib/register`).
- New `backend/loader.mjs` parses argv, conditionally inits
  Sentry, dynamically imports `index.mjs`.
- Native side (iOS + Android) passes `loader.mjs` as the
  spawn target with `--sentry*` argv flags from
  `SentryConfig` (§4.2).
- `handleFatal` and `onRequestHook` wired (§5.4, §5.5).
- Client-side `getMetadata` (§6.2) for distributed tracing
  (or accept JS-side spans without parent linkage if
  `@comapeo/ipc` doesn't yet support it — track upstream).

Value: RPC method-level errors and durations in Sentry;
backend boot failures with proper stacktraces; baseline
distributed tracing; auto-instrumentation works because
`Sentry.init()` runs before any other module loads.

Cost: ~300 LOC across loader/rollup config/native/JS;
~150–250 KB bundle delta on every consumer **on disk** but
zero runtime cost when DSN is absent (§5.1).

### 10.4 Phase 4 — `@comapeo/core` OpenTelemetry forwarding

- Bump `@comapeo/core` once PR #1051 lands.
- Verify Sentry's OTel integration picks up the spans
  with the RPC transaction as parent.
- Document any required tracing-config overrides.

Value: deep traces inside core operations (sync, indexing,
hypercore) — the data Sentry's performance tab is designed
to surface.

### 10.5 Phase 5 — capture-application-data toggle

- Native preference store (Android `SharedPreferences`,
  iOS `UserDefaults`) with `getCaptureApplicationData` /
  `setCaptureApplicationData` JS API (§9.2).
- Read on boot, passed as `--captureApplicationData` argv
  flag (§9.5), gates the §7.4.8 opt-in captures (per-RPC
  method spans, sync session transaction, background/foreground
  breadcrumbs, memory checkpoints, storage size sample).
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
- Backend loader: spawn `loader.mjs` without `--sentryDsn`
  and assert `@sentry/node` is never resolved (check
  `require.cache` / module-graph instrumentation in a test
  harness). Spawn with `--sentryDsn=...` and assert
  `Sentry.init` was called with the parsed values **before**
  `index.mjs`'s top-level imports ran.
- Backend rollup output: assert the multi-entry build
  produces `loader.mjs`, `index.mjs`, `importHook.js`, and
  `lib/register.js`; that `loader.mjs` does not statically
  reference `@sentry/node`; that the rewritten
  `module.register('./importHook.js', ...)` call is in the
  bundled output (no bare `import-in-the-middle/hook.mjs`
  reference).
- Toggle gating in loader: build with `--captureApplicationData`
  and assert `tracesSampleRate` is non-zero in the captured
  init options; build without it and assert `tracesSampleRate`
  is `0`.
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
  Node argv as `--captureApplicationData`.
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
10. **Sourcemap upload for the backend bundle**: §5.1 mentions
    `@sentry/rollup-plugin` for sourcemap upload. Confirm CI
    has `SENTRY_AUTH_TOKEN` available and that uploaded
    sourcemaps reference the right release tag (matching
    what native passes as `--sentryRelease`).
11. **Lazy chunk on iOS**: nodejs-mobile on iOS runs V8 with
    `--jitless`. Confirm dynamic `import()` works there for
    a separate ESM chunk; the mainline path is well-tested
    but the lazy path is new code. iOS is also where we
    already stub the `@comapeo/core` maps plugin to keep
    undici out (see `backend/lib/maps-stub.js` and the
    `stubComapeoMapsPlugin` in `rollup.config.ts`); the
    Sentry chunk is an additional surface for this kind of
    iOS-only quirk.
12. **Offline transport**: comapeo-mobile uses
    `sentry-offline-transport-better-sqlite` to queue events
    while offline. Decide whether v1 ships offline transport
    or accepts dropped events when the device is offline.
    Mobile fieldwork is offline more than online; this is
    likely required for production usage but adds another
    bundled dep.
13. **Capture-application-data toggle and EAS development
    builds**: development builds are presumably
    `environment: "development"` and frequently want
    detailed traces. Consider whether the toggle should
    default to `true` for non-production environments
    (read from the manifest at startup), so developers
    don't have to flip it in their settings UI on every
    fresh install. Defaulting to `false` everywhere is
    safer; defaulting to `true` for `environment !==
    "production"` is more useful. Decision pending.

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
  Validates `dsn` and `environment` are present; throws at
  prebuild on misconfiguration.
- `expo-module.config.json` — register the plugin if needed
  (the file is already wired to expo-modules via this manifest).
- `ios/SentryConfigStore.swift` (new) — read Info.plist into
  `SentryConfig`, fall back to `CFBundleShortVersionString`
  for `release` if absent.
- `android/src/main/java/com/comapeo/core/SentryConfigStore.kt`
  (new) — read manifest meta-data into `SentryConfig`, fall
  back to `versionName` for `release` if absent.
- `ios/AppLifecycleDelegate.swift` — read config and stash on
  `NodeJSService` before `runNode()`.
- `ios/NodeJSService.swift` — accept stored config, build
  argv with `--sentry*` flags for `runNode`, init
  `sentry-cocoa` (already present via `@sentry/react-native`,
  no re-init needed on iOS).
- `android/src/main/java/com/comapeo/core/ComapeoCoreService.kt`
  — read config in `onCreate`, init `SentryAndroid` for the
  FGS process, pass to `NodeJSService`.
- `android/src/main/java/com/comapeo/core/NodeJSService.kt`
  — build argv with `--sentry*` flags for the Node spawn
  call.
- `android/src/main/java/com/comapeo/core/NodeJSService.kt`,
  `ios/NodeJSService.swift` — add `Sentry.addBreadcrumb` calls
  on every state-derivation update; wrap boot phases in
  `Sentry.startSpan`; emit timeout events.
- `android/src/main/java/com/comapeo/core/ComapeoCoreModule.kt`
  (main process) — same breadcrumb/event emission from the
  control-IPC observer.

**Phase 3 — backend instrumentation (loader + multi-entry bundle)**

- `backend/package.json` — `@sentry/node` and
  `import-in-the-middle` dependencies; `@sentry/rollup-plugin`
  devDependency for sourcemap upload.
- `backend/loader.mjs` (new) — argv-driven `Sentry.init`,
  dynamic import of `index.mjs`. Mirrors
  `comapeo-mobile/src/backend/loader.js`.
- `backend/rollup.config.ts` — multi-entry input (`loader`,
  `index`, `importHook`, `lib/register`); add
  `@sentry/rollup-plugin` for sourcemap upload behind
  `SENTRY_AUTH_TOKEN`.
- `backend/rollup-plugins/rollup-plugin-import-hook.mjs` (new)
  — port of comapeo-mobile's path-rewrite plugin so
  `module.register('import-in-the-middle/hook.mjs', …)` lands
  on the bundled `./importHook.js`.
- `scripts/build-backend.ts` — pass `loader.mjs` as the new
  spawn target through to native asset trees; ensure the
  Sentry chunk and `importHook`/`lib/register` files are
  copied alongside `index.mjs`.
- `ios/NodeJSService.swift`, `android/.../NodeJSService.kt`
  — change the `runNode` / `startWithArgs` call to pass
  `loader.mjs` as the entry script (was `index.mjs`).
- `backend/index.js` — read
  `globalThis.__comapeoSentryConfig` (set by loader);
  hook `handleFatal` with `Sentry.captureException`; remove
  any `sentry` field handling from the `init` control-frame
  handler (the field is no longer sent — argv carries it).
- `backend/lib/comapeo-rpc.js` — accept `sentry` option,
  register `onRequestHook`.
- `src/ComapeoCoreModule.ts` — pass `getMetadata` to
  `createMapeoClient` (or wrapper fallback).

**Phase 4 — OpenTelemetry forwarding**

- `backend/package.json` — bump `@comapeo/core` once PR #1051
  ships.
- Smoke test verification, no code changes expected.

**Phase 5 — capture-application-data toggle**

- `android/src/main/java/com/comapeo/core/SentryPrefsStore.kt`
  (new) — `SharedPreferences` read/write of the toggle,
  plus `getCaptureApplicationData` /
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
