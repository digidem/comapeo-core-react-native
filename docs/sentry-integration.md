# Sentry Integration — Architecture

How Sentry error reporting and RPC tracing are wired into
`@comapeo/core-react-native` without forcing every consumer of this module to
ship Sentry. The integration is **opt-in and host-app driven** so that only
the CoMapeo Mobile app pays the bundle cost, sends events to a DSN, and sees
its data in Sentry — other apps that depend on this module continue to ship
with no Sentry traffic.

For the per-phase delivery record see
[`sentry-integration-history.md`](./sentry-integration-history.md). For the
work still ahead see [`sentry-integration-plan.md`](./sentry-integration-plan.md).

Companion docs:

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — process model, IPC, lifecycle.
- Reference implementation in CoMapeo Mobile:
  [`comapeo-mobile/src/backend/src/app.js`](https://github.com/digidem/comapeo-mobile/blob/develop/src/backend/src/app.js).
- Upstream OpenTelemetry instrumentation in `@comapeo/core`:
  [`comapeo-core PR #1051`](https://github.com/digidem/comapeo-core/pull/1051).

> **Mandatory peer dep.** `@sentry/react-native` is a **non-optional peer
> dependency** of this module. On iOS, `Sentry` is a hard CocoaPods
> dep of the module's podspec **and** Sentry-Cocoa is a hard SPM dep of
> `ios/Package.swift`, pinned to the same version in both places (enforced by
> `scripts/check-sentry-cocoa-pin.mjs`). The **runtime** gating still applies:
> when the Expo plugin is registered without a `sentry` argument, no DSN is
> baked into the native config and `initSentry()` returns early — Sentry is
> installed but inert.

---

## 1. Goals & non-goals

### Goals

1. **Capture errors** at every layer the module owns:
   - Node backend: `uncaughtException`, `unhandledRejection`, boot phase
     failures (`listen-control`, `init`, `construct`, `runtime`), per-RPC
     throws.
   - RN/JS layer: `state` ERROR transitions, `messageerror` protocol parse
     failures, RPC client rejections.
   - Native: rootkey load failures, watchdog timeouts, IPC connection errors,
     hard process crashes (Android FGS, iOS in-process).
2. **Trace RPC calls** end-to-end across the React Native ↔ Node boundary.
   Each RPC call appears as a span/transaction whose parent span is the
   JS-side caller.
3. **Forward OpenTelemetry spans** emitted by `@comapeo/core` (once PR #1051
   lands) to Sentry without bundle-time coupling to a specific exporter.
4. **App-specific gating**: zero Sentry traffic and zero Sentry SDK activation
   for any consumer that doesn't opt in.

### Non-goals

- Not a generic telemetry abstraction. The module speaks Sentry-shaped APIs
  (DSN, `Sentry.captureException`, OpenTelemetry-compatible spans). Other
  backends are out of scope.
- No user-PII or message contents. Spans get method names and structural
  metadata, not arguments.
- No auto-installation of Sentry SDKs on the host app's behalf. The host app
  declares the dependency; the module wires it in.

---

## 2. Why app-specific matters here

`@comapeo/core-react-native` is a library with at least two different
consumers (the CoMapeo Mobile app, the in-tree `apps/integration` integration
harness, and potentially third-party apps building on the module). We cannot:

- **Bundle a hard dependency on `@sentry/node` into the published Node
  backend.** That bundle is staged into
  `android/src/{debug,main}/assets/nodejs-project/` and `ios/nodejs-project/`
  at `npm run backend:build` time. Whatever ends up in the rollup is on every
  consumer's device, regardless of whether they want Sentry.
- **Ship a DSN.** The DSN is per-app config. It belongs in the host app's
  environment, not in the published module's source.

The integration is therefore:

1. **Inert by default.** Module installed but not configured → no Sentry
   calls, no SDK init, no trace metadata on RPC frames.
2. **Activated by the host app.** A build-time plugin entry plus a runtime
   `initSentry()` call switch instrumentation on with a DSN, environment,
   release, sample rates, etc.
3. **Reachable from all three layers.** The plugin's config propagates from
   build artifacts (manifest meta-data / Info.plist) through to the Node
   backend (via argv at `nodejs-mobile` spawn) and to native (so iOS/Android
   crash reporters can be enabled).

---

## 3. Layered architecture

Three independent Sentry scopes share a DSN and a release tag; each runs in
its own process / runtime and has its own SDK init.

```
┌──────────────────────────── Host app ─────────────────────────────┐
│                                                                   │
│    ┌─────────────── React Native (JS) ────────────────┐           │
│    │  @sentry/react-native                            │           │
│    │  - JS errors, native crashes (iOS+Android)       │           │
│    │  - starts trace for RPC calls                    │           │
│    │                                                  │           │
│    │  @comapeo/core-react-native:                     │           │
│    │  - initSentry() owns Sentry.init                 │           │
│    │  - state.on('stateChange', ERROR) → captureException        │
│    │  - state.on('messageerror', ...) → captureException         │
│    │  - comapeo.<method>() wrapper: startSpan +       │           │
│    │      attach sentry-trace + baggage in metadata   │           │
│    └──────────────────────────────────────────────────┘           │
│                            │                                      │
│                            │ argv: --sentryDsn, --sentry...,      │
│                            │       --applicationUsageData       │
│                            │ comapeo.sock RPC (with sentry-trace) │
│                            ▼                                      │
│    ┌─────────────────── Node backend ─────────────────┐           │
│    │  loader.mjs                                      │           │
│    │   - parseArgs → if DSN: Sentry.init() then       │           │
│    │     await import('./index.mjs')                  │           │
│    │   - custom transport forwards envelopes to native│           │
│    │     via the control socket (offline-safe)        │           │
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
│    │  - boot/shutdown transactions, rootkey/watchdog  │           │
│    │    captureException, lifecycle breadcrumbs       │           │
│    │  - captures Node-side envelopes via the          │           │
│    │    sentry-event / sentry-envelope control frames │           │
│    └──────────────────────────────────────────────────┘           │
└───────────────────────────────────────────────────────────────────┘
```

Key splits:

- **JS and native** share a single `@sentry/react-native` SDK that the host
  app installs. The module owns the `Sentry.init` call via
  `initSentry(options?)`.
- **Node backend** runs a separate `@sentry/node` SDK, initialised inside the
  bundle. Configuration is read at native process start from build-time-baked
  sources (Android manifest meta-data, iOS Info.plist) and forwarded to the
  backend in argv. This avoids any JS round-trip on the boot path so the FGS
  can cold-start without RN being alive.
- **Android FGS process** has its own `Sentry.init` (in
  `ComapeoCoreService.onCreate`) and its own scope. Cross-process attribution
  is via `release`+`environment`+a `proc:fgs` tag.
- **JS-side `Sentry.init`** runs with `autoInitializeNativeSdk: false` so the
  native hub is the single owner of the native SDK lifecycle (Android FGS
  init is the FGS-side authority; iOS `AppLifecycleDelegate` is the
  main-process authority).

---

## 4. Configuration

### 4.0 The cold-start constraint

Earlier drafts plumbed the backend Sentry config from JS through the
control-socket `init` frame. That had a real cost:

1. **FGS cold-start (Android).** The `:ComapeoCore` foreground service can be
   cold-launched by the system to deliver a sync trigger _before_ the host
   app's RN bridge is alive. With a JS-driven config, the FGS would have to
   either start the backend with Sentry off (losing observability for the
   most interesting code path — boot-time errors during a cold sync) or block
   on RN to come up first (defeats the purpose of an FGS-survives-RN
   architecture).
2. **Boot latency on every launch.** Even when RN is alive, the JS
   round-trip for `setSentryConfig(...)` would add a serial step to the boot
   sequence. The backend couldn't sample `boot.loader-init` or
   `boot.manager-init` spans until after RN was ready.
3. **State observability gap.** `state.getState()` reflects only transitions
   captured _after_ the JS listener is attached. Errors that fire before the
   consumer imports the JS adapter would miss Sentry entirely under the
   JS-driven model.

Three configuration vectors solve this together:

| Vector                                                         | When read                                                     | Purpose                                                                                                                                                                     |
| -------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Expo config plugin** (build-time)                            | At native process start, before any IPC                       | DSN, environment, release, sample rates. The single source of truth.                                                                                                        |
| **Persisted native preference** (runtime, restart-to-activate) | At native process start                                       | The `diagnosticsEnabled` and `applicationUsageData` toggles (§9).                                                                                                         |
| **JS adapter auto-detect** (side-effect import)                | When the consumer imports `@comapeo/core-react-native/sentry` | The sub-export probes `@sentry/react-native` via `require`-then-catch and attaches state listeners against it for `captureException` / breadcrumbs. Does **not** carry DSN. |

### 4.1 Build-time: Expo config plugin (primary)

`app.plugin.js` at the package root, registered in `expo-module.config.json`.

Plugin inputs:

| Field                            | Required                    | Source                                                                                             |
| -------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------- |
| `dsn`                            | yes                         | App-specific Sentry project DSN.                                                                   |
| `environment`                    | yes                         | Build-environment label (e.g. `development`, `qa`, `production`). The consumer decides the scheme. |
| `release`                        | no, defaults to versionName | If omitted, native reads `versionName` (Android) / `CFBundleShortVersionString` (iOS) at runtime.  |
| `tracesSampleRate`               | no                          | Sentry sampling knob.                                                                              |
| `sampleRate`                     | no                          | Sentry sampling knob.                                                                              |
| `rpcArgsBytes`                   | no                          | RPC arg-truncation cap (developer debug builds only).                                              |
| `diagnosticsEnabledDefault`      | no                          | Per-environment default for the diagnostics toggle (§9).                                           |
| `applicationUsageDataDefault`  | no                          | Per-environment default for the application-usage-data toggle (§9).                              |

The module deliberately **does not derive `environment`** — build-environment
schemes are app-specific. The consumer feeds `environment` from a build-time
source they control. The cleanest path on EAS is **`eas.json` build-profile
env vars + `app.config.js`** so the same codebase produces different
`environment` values for internal/test/release builds:

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

…and `app.config.js` (must be `.js`, not `app.json`, to read `process.env`):

```js
// app.config.js
export default {
  expo: {
    plugins: [
      [
        "@comapeo/core-react-native",
        {
          sentry: {
            dsn: process.env.SENTRY_DSN,
            environment: process.env.SENTRY_ENVIRONMENT ?? "production",
          },
        },
      ],
    ],
  },
};
```

EAS evaluates `app.config.js` with the build profile's `env` visible as
`process.env.*`, so each `eas build --profile X` bakes a different
`environment` string into the manifest / plist at prebuild time. No native
code change between profiles.

`release` is the one value the module _does_ default from existing native
config. Omitting it makes the native loader build the release tag as
**`versionName + "+" + versionCode`** (Android) /
**`CFBundleShortVersionString + "+" + CFBundleVersion`** (iOS). On EAS,
`versionCode` / `CFBundleVersion` is the auto-incremented build number, so
successive EAS builds of the same app version produce distinct release tags
— required to disambiguate internal/test builds that share a marketing
version. Consumers can still pass `release` explicitly (e.g. to embed a git
SHA from `EAS_BUILD_GIT_COMMIT_HASH`) and the explicit value wins.

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

These meta-data live on the manifest's main `<application>` tag so **both
the main process and the `:ComapeoCore` FGS process see them** —
`PackageManager.getApplicationInfo(...).metaData` is shared across processes
within the package.

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

- If the consumer registers the plugin without a `sentry` key, no meta-data /
  Info.plist entries are written. Native treats the absence as "Sentry off".
  The example app under `apps/integration/` ships unconfigured.
- If the consumer registers the plugin **with** a `sentry` key, the plugin
  validates that `dsn` and `environment` are present (throwing at prebuild
  time if they're not — fast failure beats a silently-misconfigured Sentry
  project) and writes the corresponding meta-data / plist keys. Optional
  fields are written only when provided.
- The DSN ends up embedded in the host app's APK/IPA. That's an accepted
  tradeoff: Sentry DSNs are not high-secret values (they identify a project,
  not authenticate writes; rate limiting and per-project ingest are
  server-side). They appear in stripped binaries of every Sentry-using app.

### 4.2 Native config consumption

At native process start (FGS `onCreate` on Android, app delegate init on
iOS), the module loads the manifest / plist keys into a typed `SentryConfig?`
and propagates it two ways:

```kotlin
// android/.../SentryConfig.kt — sketch
data class SentryConfig(
  val dsn: String,
  val environment: String,
  val release: String,
  val sampleRate: Double?,
  val tracesSampleRate: Double?,
  val rpcArgsBytes: Int?,
  val diagnosticsEnabledDefault: Boolean? = null,
  val applicationUsageDataDefault: Boolean? = null,
)

fun loadFromManifest(ctx: Context): SentryConfig? {
  val meta = ctx.packageManager.getApplicationInfo(
    ctx.packageName, PackageManager.GET_META_DATA
  ).metaData ?: return null
  val dsn = meta.getString("com.comapeo.core.sentry.dsn") ?: return null

  val environment = meta.getString("com.comapeo.core.sentry.environment")
    ?: error("comapeo: sentry.environment missing from manifest")

  val release = meta.getString("com.comapeo.core.sentry.release")
    ?: run {
      val pkg = ctx.packageManager.getPackageInfo(ctx.packageName, 0)
      val v = pkg.versionName ?: "unknown"
      val build = if (Build.VERSION.SDK_INT >= 28) pkg.longVersionCode
                  else @Suppress("DEPRECATION") pkg.versionCode.toLong()
      "$v+$build"
    }

  return SentryConfig(
    dsn = dsn,
    environment = environment,
    release = release,
    sampleRate = meta.getString("com.comapeo.core.sentry.sampleRate")?.toDoubleOrNull(),
    tracesSampleRate = meta.getString("com.comapeo.core.sentry.tracesSampleRate")?.toDoubleOrNull(),
    rpcArgsBytes = meta.getString("com.comapeo.core.sentry.rpcArgsBytes")?.toIntOrNull(),
    // …diagnosticsEnabledDefault / applicationUsageDataDefault read similarly
  )
}
```

iOS reads the same key set from `Bundle.main.infoDictionary`
(`ComapeoCoreSentryDsn`, `ComapeoCoreSentryEnvironment`, etc.) and falls
back to `CFBundleShortVersionString` for `release` if the plist key was
absent.

There is intentionally **no native-side derivation logic** for `environment`.
Build-environment schemes are app-specific — this module reads whatever
literal string the consumer's plugin wrote.

The loaded `SentryConfig` is consumed in two places:

1. **Native SDK init (Android FGS process).**
   `SentryAndroid.init(ctx) { options -> options.dsn = config.dsn; ... }` in
   `ComapeoCoreService.onCreate`. Allows the FGS process to capture native
   crashes, ANRs, and the §7.4 telemetry events with the same DSN.

   **iOS parallel.** `AppLifecycleDelegate.application(_:didFinishLaunchingWithOptions:)`
   owns the native `SentrySDK.start(...)` call via
   `resolveEffectiveSentryConfig()`. JS-side `initSentry()` calls
   `Sentry.init` with `autoInitializeNativeSdk: false` so the native hub is
   the single owner of the SDK lifecycle.

2. **Backend, via Node argv at spawn time.** Native serialises
   `SentryConfig` (plus the §9 toggles) into argv and passes it to
   `nodejs-mobile`'s start call. The backend's `loader.mjs` entry parses
   argv, runs `Sentry.init()`, then dynamically imports `index.mjs`.

Sentry config flows through **argv, not through the control-socket `init`
frame**. The init frame stays focused on the rootkey (which we deliberately
keep out of argv per `ARCHITECTURE.md §7.4`). The DSN is fine in argv: it's
already in the manifest of every Sentry-using app's APK/IPA, identifies a
project rather than authenticating writes, and is rate-limited server-side.

The benefits stack:

- **FGS cold-start**: Sentry config is in native config + argv; Node boots
  with full instrumentation before RN is alive.
- **Auto-instrumentation order**: `Sentry.init()` runs in `loader.mjs`
  _before_ the dynamic import of `index.mjs`, so OpenTelemetry's
  `import-in-the-middle` patches modules as they load.
- **Lazy bundle chunk**: when the manifest has no DSN, native doesn't pass
  `--sentryDsn=...` in argv; the loader's
  `if (sentryDsn) await import('@sentry/node')` short-circuits and the
  rollup-split `@sentry/node` chunk never loads.

### 4.3 JS adapter — auto-detected at module load

The sub-export probes for `@sentry/react-native` at module load via a
`try { require(…) }`:

```ts
// src/sentry-internal.ts
let detected: SentryAdapter | null = null;
try {
  detected = require("@sentry/react-native") as SentryAdapter;
} catch {
  /* peer dep absent — module stays inert */
}
```

The host's `initSentry(...)` populates the global hub; calls through
`detected.captureException(...)` reach that hub via the SDK's static methods.

Consumer usage in the host app reduces to a single side-effect import + the
init call:

```ts
import "@comapeo/core-react-native/sentry";
// …later, at app entry:
import { initSentry } from "@comapeo/core-react-native/sentry";
initSentry({ /* host extensions */ });
```

Tests can override the auto-detected adapter for fakes:

```ts
import { setSentryAdapterForTests } from "@comapeo/core-react-native/sentry";
setSentryAdapterForTests(fake);
```

Apps that don't want Sentry don't call `initSentry`. Apps that do but haven't
called it get listeners attached but no captures — silently inert.

### 4.4 Runtime opt-in toggles (forward reference to §9)

Two persisted boolean toggles in native preferences:

- `diagnosticsEnabled` — gates Sentry entirely. When off, neither the FGS
  bridge nor the backend loader nor the RN-side `Sentry.init` run.
- `applicationUsageData` — gates the _additional_ observability surface
  described in §7.4 (per-RPC method spans, sync session spans, counts) but
  never touches DSN/environment/release and never unlocks PII fields.

Both toggles use restart-to-activate semantics (read once at process start).
See §9 for the full design.

### 4.5 Backend transport: argv at Node spawn

Native passes positional argv to the Node process when it spawns
nodejs-mobile (`comapeoSocketPath`, `controlSocketPath`, `privateStorageDir`).
The module extends that with named flags for Sentry config:

```
node loader.mjs \
  <comapeoSocketPath> <controlSocketPath> <privateStorageDir> \
  --sentryDsn=https://abc@sentry.example.com/1 \
  --sentryEnvironment=production \
  --sentryRelease=1.4.2 \
  --sentryTracesSampleRate=0.1 \
  --sentryRpcArgsBytes=0 \
  --applicationUsageData      # only when toggle is on
```

Native picks the loader path (`loader.mjs`) as the entry script and
constructs the argv from `SentryConfig` plus the persisted toggle values.
When the manifest has no DSN, the `--sentry*` flags are omitted entirely;
the loader's first check is `if (!sentryDsn) await import('./index.mjs')` —
no `@sentry/node` chunk is ever loaded.

The control-socket `init` frame stays focused on the rootkey:

```js
// Native → Node, on control.sock
{ type: "init", rootKey: "<base64>" }
```

Why argv is the right transport for Sentry config (and not the rootkey):

|                                       | Sentry config                        | Rootkey                           |
| ------------------------------------- | ------------------------------------ | --------------------------------- |
| Already in app binary?                | Yes (manifest / plist)               | No (encrypted in keystore)        |
| Server-side rate limited?             | Yes                                  | n/a — single bytes are the secret |
| Visible in `/proc/<pid>/cmdline`?     | Yes                                  | Would be — that's the problem     |
| Needed before any other module loads? | **Yes** (auto-instrumentation order) | No (received post-handshake)      |
| Right transport                       | argv                                 | init frame                        |

Argv satisfies the auto-instrumentation order requirement: `Sentry.init()`
must run before any module that Sentry wants to patch is imported. The
control-socket init frame arrives _after_ `index.js` has already imported
`@comapeo/core`, `fastify`, and friends; argv is the only transport that
arrives before the loader's first import.

---

## 5. Backend instrumentation (`backend/`)

### 5.1 Bundle strategy: multi-entry with lazy `@sentry/node` chunk

**Pinned versions**: `@sentry/node-core@^10` + `@sentry/core@^10` +
`@sentry/opentelemetry@^10` (backend), `@sentry/react-native@^8`,
`import-in-the-middle` (whatever the Node SDK resolves it at). These are
the OpenTelemetry-first majors — required for §5.6 forwarding of
`@comapeo/core` PR #1051 spans to "just work" without glue code.

Bundle layout:

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
└── chunks/sentry-*.mjs # Auto-emitted rollup chunk holding
                        #   @sentry/node + transitive deps. Loaded
                        #   only when loader.mjs awaits the dynamic
                        #   import.
```

Why each piece is separate:

- **`loader.mjs`** is the spawn target. Native passes `loader.mjs` to
  nodejs-mobile instead of `index.mjs`. The loader parses `--sentryDsn`/etc.
  from `process.argv`, dynamically imports `@sentry/node` if a DSN is
  present, calls `Sentry.init()`, then `await import('./index.mjs')`.
  Without the init-before-other-imports order, Sentry's OpenTelemetry
  auto-instrumentation can't patch modules.
- **`importHook.js`** is `import-in-the-middle/hook.mjs`, which
  OpenTelemetry registers as a Node module-loading hook via
  `module.register('import-in-the-middle/hook.mjs', ...)`. `module.register`
  requires a **separate file** loaded fresh in a child loader thread; it
  can't be bundled into the same module that calls `module.register`.
- **`lib/register.js`** is a sub-dep of `import-in-the-middle` that resolves
  via a hard-coded relative path (`./lib/register.js`). Cannot be bundled.
- **`chunks/sentry-*.mjs`** is what rollup auto-emits when it sees
  `await import('@sentry/node')` in the loader and the rest of the bundle
  never touches it statically. Consumers who don't pass `--sentryDsn` never
  load this chunk; the cost is install-time disk only.

A path-rewrite plugin (`backend/rollup-plugins/rollup-plugin-import-hook.mjs`)
rewrites calls like `module.register('import-in-the-middle/hook.mjs', …)` to
`module.register('./importHook.js', …)` so the runtime register call points
at the bundled output rather than the node_modules path that no longer
exists post-bundle.

Bundle-size cost:

- Consumers **with** Sentry: ~150–250 KB extra in the per-platform output
  dir (the sentry chunk plus `importHook` / `lib/register`). Loaded into V8
  only when DSN is present.
- Consumers **without** Sentry: same disk cost (the chunks ship in
  `nodejs-project/`), but **zero runtime cost**: the `@sentry/node` chunk is
  never required by any path the loader executes when `--sentryDsn` is
  absent. The loader itself is tiny (~1 KB) and runs unconditionally.

**Sourcemaps — generate here, upload from the consumer.** Rollup emits
`.map` files alongside each output. The module:

1. Ships sourcemaps in the npm package (in `package.json`'s `files` field).
2. Documents APK/IPA exclusion of `nodejs-project/**/*.map` in the
   consumer's gradle / Xcode build (small build step, in README). Sourcemaps
   on device are dead weight — only Sentry needs them — and shipping them
   inflates the install size and exposes readable backend source to anyone
   who unpacks the APK.
3. Documents the upload step for consumers. Each consumer's release CI
   calls `sentry-cli sourcemaps upload` (or the equivalent EAS hook)
   against the `.map` files in
   `node_modules/@comapeo/core-react-native/.../nodejs-project/`, tagged
   with the same release string the plugin baked into the manifest
   (`versionName + "+" + versionCode`).

We do **not** add `@sentry/rollup-plugin` here. Pushing uploads from a
library's CI to a consumer-owned Sentry project would require the consumer
to surface their `SENTRY_AUTH_TOKEN` to this module's CI — wrong direction.

### 5.2 `loader.mjs` — `Sentry.init()`, custom transport, dynamic import

```js
// backend/loader.mjs — sketch
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    sentryDsn: { type: "string" },
    sentryEnvironment: { type: "string" },
    sentryRelease: { type: "string" },
    sentryTracesSampleRate: { type: "string" },
    sentrySampleRate: { type: "string" },
    sentryRpcArgsBytes: { type: "string" },
    applicationUsageData: { type: "boolean", default: false },
  },
  allowPositionals: true,
  strict: false,
});

if (values.sentryDsn) {
  const Sentry = await import("@sentry/node");
  Sentry.init({
    dsn: values.sentryDsn,
    environment: values.sentryEnvironment ?? "production",
    release: values.sentryRelease,
    sampleRate: Number(values.sentrySampleRate ?? 1.0),
    // Native resolves the effective rate (debug window folds in there)
    // and forwards it; the backend mirrors it verbatim.
    tracesSampleRate: Number(values.sentryTracesSampleRate ?? 0),
    transport: makeControlSocketTransport(), // see §5.7
    initialScope: { tags: { layer: "node" } },
  });
}

await import("./index.mjs");
```

The loader stashes the parsed config on globals so `index.mjs` can read it
back without re-parsing argv:

```js
globalThis[SENTRY_CONFIG_GLOBAL] = {
  rpcArgsBytes: Number(values.sentryRpcArgsBytes ?? 0),
  applicationUsageData: values.applicationUsageData,
};
```

### 5.3 `index.mjs` — read parsed config, no Sentry init

`backend/index.js` reads `globalThis[SENTRY_CONFIG_GLOBAL]` for the RPC hook
+ toggle flags it needs. It does **not** call `Sentry.init()` (that already
happened in the loader). To keep the lazy behaviour intact, `index.mjs`
**never names `@sentry/node` statically**; instead the loader stashes
`globalThis[SENTRY_GLOBAL] = Sentry` and `index.mjs` reads from globalThis.
The rollup chunk is unambiguously gated by the loader's argv check.

### 5.4 Error capture wiring

Three failure surfaces in `backend/index.js`:

1. **`handleFatal(phase, error)`** — the single funnel for uncaught
   exceptions, unhandled rejections, and boot-phase throws. Captures with
   `tags: { phase, layer: "node" }` and attaches `os.freemem`,
   `os.totalmem`, and `fs.statfsSync` results as extras (cheap fix for
   `@sentry/node` not synthesising device context the way the RN / native
   SDKs do). Flushes for 100 ms before `process.exit(1)`.
2. **`error-native` handler** — frames forwarded from Android FGS-local
   failures (rootkey, watchdog) reach `handleFatal` with the FGS-supplied
   phase, so they get captured by #1 automatically. Tagged
   `tags: { source: "native" }`.
3. **Per-RPC errors** — handled in §5.5.

### 5.5 RPC tracing — server side

The `onRequestHook` registered by `backend/lib/comapeo-rpc.js`:

```js
// backend/lib/comapeo-rpc.js (sketch)
function makeSentryRequestHook() {
  return (request, next) => {
    const sentryTrace = request.metadata?.["sentry-trace"];
    const baggage = request.metadata?.baggage;
    return Sentry.continueTrace({ sentryTrace, baggage }, () =>
      Sentry.startSpan(
        {
          op: "rpc.server",
          name: request.method.join("."),
          forceTransaction: true,
          attributes: {
            "rpc.system": "comapeo-ipc",
            "rpc.method": request.method.join("."),
          },
        },
        async (span) => {
          try {
            await next(request);
            span.setStatus({ code: 1, message: "ok" });
          } catch (error) {
            // Observe for tracing + metrics only — the hook does NOT capture
            // an issue. An RPC rejection is often expected control flow (e.g.
            // NotFound); whether it's worth reporting is the calling
            // application's decision, at the call site.
            span.setStatus({ code: 2, message: "internal_error" });
          }
        },
      ),
    );
  };
}
```

Notes:

- The hook is only registered when Sentry is active; absent config,
  `createMapeoServer` is called without `onRequestHook` and there is zero
  overhead.
- The hook is observational: it records duration/status metrics and (under
  `debug`) a trace span, but never calls `captureException`. The RPC response
  and its rejection flow back to the JS caller through rpc-reflector's own
  channel independently of the hook, so swallowing the error here does not
  affect the caller. Error *reporting* is left to the call site.
- `request.args` is not serialised by default. In CoMapeo data the args can
  be project-scoped content (observation fields, attachments). Opt-in only
  via `rpcArgsBytes`.

### 5.6 OpenTelemetry forwarding (PR #1051)

When `comapeo-core` PR #1051 merges, `@comapeo/core` will emit
OpenTelemetry spans through the global `@opentelemetry/api` provider.
`@sentry/node` v8+ is built on OpenTelemetry: spans emitted via
`@opentelemetry/api` are picked up automatically by the Sentry span
processor.

Concretely, after `Sentry.init()`, no further wiring is needed —
`@comapeo/core`'s spans become children of the active Sentry transaction
(the RPC span from §5.5) and ship to the configured DSN.

### 5.7 Offline transport via control-socket forwarding

`@sentry/node` ships an HTTP transport that drops envelopes when the
network is unreachable. The native SDKs (`sentry-android`, `sentry-cocoa`)
already run in the host process with offline-aware transports —
connectivity events, exponential backoff, `retry-after` handling, on-disk
envelope cache, all there. The Node-side transport is replaced with a
forwarder that pipes payloads to native, where they ride the existing
queue.

**Wire format** (two `ControlFrame` variants, both Node → native):

- `{"type":"sentry-event", "payload":<event JSON>}` — single-item
  error-event envelopes. Native deserialises into a `SentryEvent` via
  `SentryEvent.Deserializer` (Android) /
  `SentryEventDecoder.decodeEvent(jsonData:)` (iOS,
  `@_spi(Private) import Sentry`) and captures via `Sentry.captureEvent` /
  `SentrySDK.capture(event:)`. Going through the capture-event path means
  the native SDK applies its scope (device, OS, app, user, native
  breadcrumbs) at capture time — so Node doesn't have to carry that
  context.

- `{"type":"sentry-envelope", "data":<base64>}` — everything else
  (transactions, sessions, check-ins, profiles, multi-item event
  payloads). Native hands the bytes to its hybrid envelope-capture
  entrypoint — `InternalSentrySdk.captureEnvelope(bytes, false)` on
  Android, `PrivateSentrySDKOnly.envelope(with:)` + `captureEnvelope:` on
  iOS. Native scope is _not_ merged on this path — that's fine because the
  relevant transactions are opened natively and the Node-side spans
  inherit the parent's context via `continueTrace`.

The custom transport in `loader.mjs` inspects each envelope: a single-item
envelope whose only item has `type: "event"` rides the event path;
anything else falls through to the envelope path.

**Buffering.** Two ring buffers (each 100, FIFO-evict) cover the gaps in
the boot sequence: one in `loader.mjs` for captures that happen before
`index.js` registers the sink (i.e. before the control socket binds); one
in `SimpleRpcServer` for the window between sink registration and first
client connect. The first client to connect drains both — subsequent
clients (e.g. the Android main-app `ComapeoCoreModule` connecting after
the FGS) do not get a replay, since the FGS is the only consumer of
Sentry frames in practice.

**Why not `SentryTransaction.Deserializer` for transactions?** sentry-android
exposes one and `Sentry.getCurrentScopes().captureTransaction(...)` is
reachable. sentry-cocoa doesn't expose a transaction decoder, and writing
one ourselves would mean walking every span / span-context type by hand.
Symmetric envelope-only across both platforms is simpler.

**Stability note for iOS.** `SentryEventDecoder` is marked `@_spi(Private)`
in sentry-cocoa — Sentry's "hybrid-SDK-only, may rename in future minors"
tag. The same selector is used internally by
`SentryFileManager.readAppHangEvent` on every cocoa release, so it's
exercised continuously. The version is pinned by `@sentry/react-native`'s
podspec (`Sentry '9.15.0'` for RN 8.13.0); re-validate when
bumping. Fallback if Sentry yanks the symbol: vendor
`Sources/Swift/Protocol/Codable/` (~700 LOC, self-contained) into the iOS
sources.

---

## 6. JS / RN module instrumentation (`src/`)

### 6.1 Files

- `src/sentry.ts` — public sub-export. `initSentry()`,
  `getDiagnosticsEnabled` / `setDiagnosticsEnabled`,
  `getApplicationUsageData` / `setApplicationUsageData`, types, state
  listeners.
- `src/sentry-internal.ts` — module-private state holding the
  auto-detected adapter (or `null`), keyed reads for the RPC wrapper.
- `src/sentry-tags.ts` — tag-key constants shared with the native side.

The main barrel (`src/index.ts`) is unchanged so consumers who don't import
the sub-export get no Sentry types or runtime code linked in.

### 6.2 RPC client tracing — request side

`createMapeoClient` accepts an `onRequestHook` of the same shape as the
server's. The hook starts a span for the RPC call, reads
`sentry-trace`/`baggage` from the active span via `@sentry/core`'s
`getTraceData`, and stuffs them into `request.metadata` so the server-side
`onRequestHook` (§5.5) can `Sentry.continueTrace` them as the parent
context.

```ts
// src/ComapeoCoreModule.ts (shape — actual file uses startNewTrace
// when there's no caller transaction so each RPC gets a fresh trace_id)
export const comapeo: MapeoClientApi = createMapeoClient(messagePort, {
  timeout: Infinity,
  onRequestHook: (request, next) => {
    if (!Sentry.isInitialized()) {
      next(request).catch(noop);
      return;
    }
    Sentry.startSpan(
      {
        name: request.method.join("."),
        op: "rpc.client",
        attributes: {
          "rpc.system": "comapeo-ipc",
          "rpc.method": request.method.join("."),
        },
      },
      async (span) => {
        const traceHeaders = getTraceData({ span });
        if (traceHeaders) {
          request.metadata = {
            "sentry-trace": traceHeaders["sentry-trace"],
            baggage: traceHeaders["baggage"],
          };
        }
        try {
          await next(request);
          span.setStatus({ code: 1, message: "ok" });
        } catch (error) {
          span.setStatus({ code: 2, message: "internal_error" });
          Sentry.captureException(error);
        }
      },
    );
  },
});
```

The hook is registered unconditionally at module load and gates on
`Sentry.isInitialized()` per call. The cost when Sentry is off is one
function call and one falsy check.

### 6.3 State observer capture

`state` already surfaces every error condition the JS layer sees.
`initSentry()` registers two listeners:

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

Phase tags align with the values produced in `src/ComapeoCore.types.ts` and
the native sources (`rootkey`, `node-runtime-unexpected`,
`shutdown-timeout`, `starting-timeout`, `ipc`, `listen-control`, `init`,
`construct`, `runtime`). They become Sentry filterable tags so the team can
dashboard "rootkey load failure rate" or "FGS watchdog timeout rate"
without parsing message strings.

### 6.4 Public client error capture

The IPC client surfaces RPC errors as rejected promises. Most captures
happen on the backend side (§5.5) and reach Sentry from there with full
context. The JS side adds a thin `captureException` for client-perceived
errors (e.g. RPC timeouts, disconnect mid-call) that the backend never
observed.

---

## 7. Native instrumentation (`ios/`, `android/`)

### 7.1 Loading config and forwarding to the backend

Native reads `SentryConfig` from the manifest / Info.plist (§4.2) at
process start. No JS bridge call is required; config is in place before RN
can boot.

- **iOS**: `AppLifecycleDelegate.application(_:didFinishLaunchingWithOptions:)`
  reads `Bundle.main.infoDictionary`, stores `sentryConfig` on
  `NodeJSService`, and (when `diagnosticsEnabled` is true) calls
  `SentrySDK.start(...)` natively.
- **Android (FGS)**: `ComapeoCoreService.onCreate` reads
  `packageManager.getApplicationInfo(...).metaData`, gates on
  `ComapeoPrefs.open(ctx).readDiagnosticsEnabled()`, then calls
  `SentryFgsBridge.init(...)` and stores `sentryConfig` on `NodeJSService`
  before `start()`.
- **Android (main process)**: reads the same metaData when
  `ComapeoCoreModule` first instantiates, used only for the control-IPC
  observer to add §7.4 breadcrumbs/events from the main process. The
  main-process Sentry SDK is initialised by `@sentry/react-native` from the
  JS-side `initSentry()` call.

The runtime opt-in toggles (§9) are read from native preferences at the
same moment and merged into the argv that `loader.mjs` parses.

### 7.2 Android FGS process

The FGS runs in the `:ComapeoCore` process — see `ARCHITECTURE.md §2.2`.
`Sentry.init()` in the host app's `MainApplication` runs only in the main
process; the FGS process gets a fresh `Application` and needs its own init.

`ComapeoCoreService.onCreate` calls `SentryAndroid.init(...)` via
`SentryFgsBridge` after reading the prefs gate. The bridge is a thin shim
that:

- Sets `proc:fgs` and `layer:native` as process-level tags so dashboards
  split FGS captures from main-process captures (which carry `proc:main`).
- Wraps the per-event methods (`addBreadcrumb`, `captureException`,
  `captureMessage`, `startBootTransaction`, `startBootSpan`, `finishSpan`)
  used by `NodeJSService`.

The library manifest disables `sentry-android`'s auto-init so the bridge is
the single owner of the FGS-process SDK lifecycle (commit `dfce999`).

### 7.3 Native telemetry data design

Sentry has a small set of primitives, each suited to different kinds of
data. The captures are designed around them rather than dumping logs:

| Sentry primitive                                  | Use for                                                                                                              | Example                                                                                        |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Breadcrumb**                                    | Lightweight ordered context — what led up to an event. Cheap, capped at ~100 by default, attached to the next event. | "state STARTING→STARTED at t+312ms", "ipc connected", "FGS notification posted"                |
| **Transaction** (root span)                       | A timed unit of work with a clear start/end and a name. Indexed; dashboards can chart durations and counts.          | `comapeo.boot` (start→started), `comapeo.shutdown` (stop→stopped)                              |
| **Span** (child)                                  | A nested timed sub-step inside a transaction.                                                                        | `boot.fgs-launch`, `boot.extract-assets`, `boot.node-spawn`, `boot.rootkey-load`               |
| **Event** (`captureMessage` / `captureException`) | A discrete error or notable occurrence; full stacktrace + context.                                                   | rootkey load failure, watchdog timeout fired, FGS killed by OS                                 |
| **Tag**                                           | Indexed key/value pair on events — used for dashboard filtering.                                                     | `phase:rootkey`, `proc:fgs`, `comapeo.state:ERROR`, `platform:android`                         |
| **Context** (custom)                              | Structured but non-indexed — appears on event detail pages.                                                          | `{"comapeo": {"abi": "arm64-v8a", "nodejs_mobile_version": "...", "ipc_socket_age_ms": 1234}}` |
| **User** (anonymized)                             | A stable but non-identifying user/session id.                                                                        | host-app-supplied install ID; never the rootkey                                                |

#### 7.3.1 State transitions → breadcrumbs

Every `ComapeoState` transition
(`STOPPED`/`STARTING`/`STARTED`/`STOPPING`/`ERROR`) is captured as a
breadcrumb on both the FGS-side and main-process Sentry scopes. Category
`comapeo.state`, level mapped from transition type.

#### 7.3.2 Boot as a transaction with phase spans

Boot is modelled as a Sentry transaction that spans from `start()` to
either `STARTED` or `ERROR`:

```
Transaction: comapeo.boot                     [layer:native]
├─ boot.fgs-launch              (Android only) [layer:native]
├─ boot.extract-assets          (Android only, first boot after install/update) [layer:native]
├─ boot.node-spawn                             [layer:native]
│  ├─ <C/C++ V8 bootstrap — uninstrumented gap>
│  ├─ boot.loader-init                          [layer:node]
│  │  ├─ boot.loader-import-sentry-node         [layer:node]
│  │  └─ boot.import-index                      [layer:node]
│  └─ boot.manager-init                         [layer:node]
└─ boot.rootkey-load                           [layer:native]
```

The init-frame round-trip (`sendInitFrame()` → `ready` control frame)
doesn't have its own span — duration is dominated by Node-side
`boot.manager-init`. The `"init frame sent"` + control `"received: ready"`
breadcrumb pair remains.

Span op + name conventions: every boot span uses `op = name = "boot.<phase>"`.
sentry-java's child-span wire format has no separate `name` field —
Discover renders `span.name = op` for child spans, so keeping the phase
identifier in `op` is what makes the trace view readable. Filter the whole
boot timeline in Discover with `op:boot.*`.

Cross-layer trace propagation: the native side opens `comapeo.boot` on a
fresh trace, then forwards the `boot.node-spawn` span's `sentry-trace`
header to the Node process as the `--sentryTrace` argv flag. The Node
side's `Sentry.continueTrace` wraps all four Node-side phase spans, so
they inherit the FGS-side trace_id and parent_span_id. Every boot span
across both layers shares one trace, viewable on a single timeline in the
Sentry Trace view. Extending this to the RN-side `App Start` transaction
is tracked as a follow-up in
[#68](https://github.com/digidem/comapeo-core-react-native/issues/68).

The transaction is **always-on essential telemetry**: durations at boot
are first-class signal for performance regressions. Native sample rate is
independent of `tracesSampleRate` — boot is sampled at 100% even when
`tracesSampleRate=0.01` for RPC.

#### 7.3.3 Shutdown as a transaction

Symmetric: `comapeo.shutdown` transaction from `stop()` to final `STOPPED`
(or `ERROR` if shutdown timed out). Spans for `shutdown.broadcast-stopping`,
`shutdown.close-rpc`, `shutdown.node-join`.

#### 7.3.4 Timeouts → events (always)

Every timeout enumerated in `ARCHITECTURE.md §5.7` becomes a Sentry event
when it fires, tagged with which timeout it was:

| Timeout                                     | Sentry shape                                                     | Tags                                          |
| ------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------- |
| iOS `startupTimeout` (30s)                  | `captureMessage("comapeo: startup timeout fired")` `level=error` | `timeout:startup, platform:ios, layer:native` |
| iOS `stop(timeout:)`                        | `captureMessage("comapeo: stop timeout fired")` `level=warning`  | `timeout:shutdown, platform:ios`              |
| iOS `waitForFile`                           | `captureMessage("comapeo: waitForFile timeout")` `level=error`   | `timeout:waitForFile`                         |
| iOS `connectWithRetry` exhausted            | event with `attempts` context                                    | `timeout:connectRetry`                        |
| Android `startupTimeoutMs` (30s)            | `captureMessage(...)` `level=error`                              | `timeout:startup, platform:android, proc:fgs` |
| Android FGS `withTimeout` (10s) on stop     | `captureMessage(...)` `level=error`                              | `timeout:fgsStop, proc:fgs`                   |
| Android `SEND_ERROR_NATIVE_TIMEOUT_MS` (2s) | breadcrumb + `level=warning` event                               | `timeout:errorNativeForward`                  |
| Android `waitForFile` (30s)                 | `captureMessage(...)` `level=error`                              | `timeout:waitForFile`                         |

Always-on essential telemetry.

#### 7.3.5 IPC connection lifecycle → breadcrumbs + events

`NodeJSIPC.State` transitions
(`Connecting`/`Connected`/`Disconnecting`/`Disconnected`/`Error`) become
breadcrumbs at `category: "comapeo.ipc"`. Disconnects from a `Connected`
state in non-stopping conditions also fire an event tagged
`ipc.unexpected_disconnect:true` with the pre-disconnect JS state — that's
the path that derives `ERROR` phase `node-runtime-unexpected`.

#### 7.3.6 FGS lifecycle → breadcrumbs

Android-only: the `ComapeoCoreService` lifecycle hooks (`onCreate`,
`onStartCommand`, `onTaskRemoved`, `onDestroy`) and notification
post/cancel become breadcrumbs at `category: "comapeo.fgs"`.

#### 7.3.7 Native error tagging

When `NodeJSService` enters ERROR locally (rootkey load, watchdog), it
populates `_lastError` and emits `stateChange`. The JS-visible capture
happens in §6.3, but on Android FGS that capture lands in the _main_
process — the FGS's own context (logcat tail, foreground state,
notification ID) is in the _FGS_ process's Sentry scope.

If the FGS-side Sentry SDK is initialised, the FGS error handler also
calls `Sentry.captureException`, tagged `proc:fgs phase:<phase>`,
**before** forwarding the `error-native` frame to Node. The duplicate
event (FGS-side + backend-side via `error-native` re-broadcast +
main-process JS-side via `stateChange`) is deduplicated by Sentry's
fingerprinting; the three captures together carry the FGS context, the
backend stack, and the main-process state-machine trail.

iOS doesn't need this — the FGS doesn't exist there, everything runs in
the host app process. The iOS native side does forward the `error-native`
frame to Node on rootkey/watchdog failure so backend-side and main-process
captures still fire (commit `6bd4852`).

#### 7.3.8 Essential vs opt-in captures

| Capture                                                            | Tier                                          |
| ------------------------------------------------------------------ | --------------------------------------------- |
| State transition breadcrumbs                                       | **Essential**                                 |
| Boot transaction + phase spans                                     | **Essential** — forced 100% sample            |
| Shutdown transaction + phase spans                                 | **Essential**                                 |
| Timeout events                                                     | **Essential**                                 |
| ERROR `captureException` (FGS, backend, main)                      | **Essential**                                 |
| IPC connection breadcrumbs                                         | **Essential**                                 |
| Unexpected-disconnect event                                        | **Essential**                                 |
| FGS lifecycle breadcrumbs                                          | **Essential**                                 |
| Per-RPC method spans (sampled)                                     | **Opt-in** (`applicationUsageData == true`) |
| Sync session transaction (start → ready → finish, with peer count) | **Opt-in**                                    |
| Background/foreground transitions                                  | **Opt-in**                                    |
| Backend memory/heap snapshots (periodic)                           | **Opt-in**                                    |
| Storage size of `privateStorageDir` (periodic)                     | **Opt-in**                                    |

### 7.4 Hard-crash reporting

Crashes that bypass JS (SIGSEGV in a native addon, OOM kill,
`process.abort()`) are documented in `ARCHITECTURE.md §6` as "belong in a
separate channel". `sentry-cocoa` and `sentry-android` handle native
crashes for the host app process; on Android the FGS process has its own
init (§7.2) to capture FGS-process crashes.

The module does **not** bundle `sentry-native` into the embedded
`nodejs-mobile` runtime. A V8 abort or libnode crash will not produce a
Sentry event from inside Node — but it will produce an Android-process
crash (since the FGS process dies) which `sentry-android` captures with a
stacktrace from the JNI side.

### 7.5 App-exit telemetry

Post-mortem visibility on _why the OS killed us_, answering "does our
backend stay alive long enough on this user's device?" per platform.
Both sides emit one **`comapeo.app.exit` count metric** per kill (via
Sentry Application Metrics — `Sentry.metrics()` on Android,
`SentrySDK.metrics` via `SentryNativeBridge.countMetric` on iOS).
Metrics, not events, because the goal is aggregate statistics ("which
OEMs kill our process hardest"), not per-incident triage — metrics have
no issue lifecycle, so nothing sits unresolved in the Issues UI and
nothing fires regression alerts. Attributes carry the slice axes; query
in Sentry's Explore UI. Breadcrumb category: `comapeo.exit`.

#### 7.5.1 Android — historical exit reasons (`ExitReasonsCollector.kt`)

On each process start (API 30+ only; pre-30 sets a one-time scope tag
`exitReasons.supported=false`), `ActivityManager.getHistoricalProcessExitReasons`
records newer than a per-process high-water timestamp are decoded into
one count each (capped at the newest 10 per process per run). Two
callers, each reporting its own process only: the main process via
`ComapeoCoreApplicationLifecycleListener` and the FGS process from
`ComapeoCoreService.onCreate`. Collection only runs once Sentry is
initialised — the main process waits (up to 2 minutes) for the
JS-triggered `Sentry.init`, the FGS runs after `SentryFgsBridge.init` —
and the high-water mark advances only AFTER the captures plus a
`Sentry.flush` (metrics sit in an in-memory 5s batch — without the flush
a kill right after collection would lose the batch while the mark write
consumed the records), so records are never consumed by a no-op report
(at-least-once: a process death between flush and the mark write
re-emits duplicates, a tolerable overcount in aggregate stats). First
observation initialises the high-water mark to
"now" and emits nothing, so a device's first update never floods Sentry
with the pre-feature backlog.

Diagnostic-tier attributes: `proc`, `exit.reason` (decoded `REASON_*`,
lowercase; unknown ints → `unknown:<int>`), `exit.process_state` (decoded
importance), `exit.signal` (when signaled), `exit.intentional`
(user/app-initiated exits, so kill-rate dashboards can exclude them),
`exit.severity` (`error` for system kills, `warning` for crash-shaped
reasons — the crash itself is captured by sentry-android, this is the
cross-referenceable post-mortem — `info` otherwise), the headline
`oem.killer.suspected` — `signaled` + SIGKILL +
foreground/foreground-service importance, the signature of OEM custom
killers reaching past FGS protection — plus `description`, `pss_kb`,
`rss_kb`, `exit_timestamp_ms`, and the coarse duration buckets
`uptime_bucket` / `bg_duration_bucket` /
`comapeo.fgs.killed_in_background`. The buckets sit at diagnostic
(not usage) tier deliberately: they're aggregate, low-resolution
cohort axes, not a per-user timeline.

App-usage-tier additions (only when `applicationUsageData` is on):
the exact `alive_for_ms` / `backgrounded_for_ms` values — millisecond
precision over a user's backgrounding behaviour is usage-shape data,
see §8. Durations derive from wall-clock anchors in
`BackgroundAnchors.kt` (`process_started_at_wall_ms` per process, plus
the main process's `backgrounded_at_wall_ms` / `foregrounded_at_wall_ms`
stamped via `ProcessLifecycleOwner` ON_STOP/ON_START). Each process owns
one anchors file (`com.comapeo.core.anchors.<proc>`) and only ever
writes its own — `SharedPreferences` is not multi-process safe, so a
shared file would let one process's write clobber the other's keys; the
FGS reads the `main` file read-only on its cold start. An exit counts as
"in background" when the last fg/bg stamp before its timestamp was a
background — neither stamp is ever cleared, so the answer stays correct
even though the relaunch (which foregrounds the app) happens before the
FGS gets to collect. Each caller snapshots the previous session's
anchors before stamping its own, so collection can run arbitrarily late.

Known coverage gaps (affects dashboard math): some OEM killers (older
MIUI, EMUI) kill via `init`-level paths that leave no
`ApplicationExitInfo` record, and some ROMs clear records on reboot.
The system also persists records asynchronously — a START_STICKY FGS
restart can query within ~2s of the kill and see nothing (the record
then surfaces on the next start, since the high-water mark only advances
past reported records), and in a rapid kill→restart burst the first
record can be skipped permanently when a newer one is reported while it
is still unwritten (observed on an API 34 emulator). Best-effort by
design. `traceInputStream()` is deliberately not captured (size + PII
risk); `description` is a short vendor label and safe.

#### 7.5.2 iOS — MetricKit app-exit metrics (`AppExitMetricsCollector.swift`)

sentry-cocoa subscribes only to MetricKit's _diagnostic_ side; the
_metric_ side — `MXMetricPayload`, where `MXAppExitMetric` lives — is an
explicit gap this module closes. `AppExitMetricsCollector` subscribes in
`AppLifecycleDelegate.didFinishLaunchingWithOptions` (once per process;
retained statically because deliveries are 24h aggregates arriving up to
a day later) and forwards each non-zero exit bucket as one
`comapeo.app.exit` count with the bucket's cumulative value as the
metric value — a count of N IS the N exits, so there's no per-event
duplication and nothing to tier-gate; the whole emission sits at
diagnostic.

Attributes: `exit.cohort` (`foreground`/`background`), `exit.bucket`,
`exit.intentional` (`normal_app_exit` only), `exit.cause_class`
(`memory` / `watchdog` / `crash` / `lock` / `normal`; unknown future
buckets degrade to `unknown`), `exit.severity` (`error` for the
background-kill and user-visible-quality buckets; `warning` where
another sentry-cocoa integration captured the death itself so kill-rate
dashboards don't double-count — crash-shaped buckets, since the crash
reporter has the real crash, and *foreground* `memory_resource_limit` /
`app_watchdog`, since watchdog-termination tracking is enabled by
default and covers foreground deaths only; `info` for normal/lock
exits), `window_start_iso`, `window_end_iso`, `window_duration_seconds`,
`app_version`, `os_version`. The pure decode logic (`AppExitDecoder`) is
MetricKit-free and unit-tested on macOS.

Rollout caveats: TestFlight builds don't receive MetricKit data (App
Store + Xcode-attached debug sessions only — the feature is invisible in
beta channels), there's no back-fill (each fresh install has a warm-up
day), and `cumulative*` fields are per-window aggregates — never subtract
across payloads.

---

## 8. PII, sampling, and privacy

CoMapeo data is sensitive (observation locations, attachments, device
identities). Defaults must avoid leaking it into Sentry:

- **`request.args` is never serialised** unless `rpcArgsBytes > 0` is
  explicitly set. Method names and metadata only.
- **No project IDs in span names**; only RPC method paths
  (`project.observation.create`, etc.). If we later want per-project
  breakdowns, hash the project ID before adding it as a tag.
- **No rootkey, no public/secret keypair, no observation contents** in
  event payloads.
- **Stacktraces** are fine — they may include filenames from inside
  `@comapeo/core` and the bundled backend. No user data unless an
  `Error.message` was constructed with one.
- **`tracesSampleRate`** is `1.0` while the user-bounded `debug` window
  is on, otherwise the plugin-configured rate — and `0` when the plugin
  doesn't set one, which is the expected production config. The plugin
  field is a build-time consumer decision (e.g. sampling internal/QA
  builds), not a per-user setting.
- **`sendDefaultPii: false`** is locked by `initSentry()`; the host can't
  override it.

### Hard never-capture list

Independent of any toggle, these are off by construction — not behind a
config option, not behind `rpcArgsBytes>0`, not ever:

- The 16-byte rootkey, in any encoding.
- Identity public/secret keypairs derived from the rootkey.
- Observation contents (text, attachments, attachment paths).
- Precise location (lat/lng). If we ever want geographic distribution
  data, it goes through quantization to ~country/region resolution at the
  host-app layer, never here.
- User-entered text from any settings UI.
- Project IDs in raw form. If included as a tag, must be hashed (SHA-256,
  truncated to 16 chars) at capture site.
- Peer device identities or discovered peer counts above bucketed
  thresholds (e.g. record `peers_bucket: 1-3 / 4-10 / 10+`, not raw
  counts).
- File paths under `Application Support` or `getFilesDir()` that include
  the rootkey or project IDs.

A scrubber enforces the list defensively on both sides of the IPC
boundary (`src/sentry-scrub.ts` on RN, `backend/before-send.js` on
Node; shared test cases in `test-support/scrubber-cases.js` keep the
two copies from drifting): it walks the event tree — message, exception
values, extra, contexts, breadcrumbs, structured logs — redacting
`rootKey`-marked values and coordinate markers (`lat`, `lng`, `lon`,
`latitude`, `longitude`, in key/value and JSON-serialized forms). A
broad base64-22-char rule (to catch *bare* unmarked rootkeys) is
deliberately **not** enabled: it also matched trace IDs and exception
type names; a narrower design is pending, and until then bare unmarked
tokens pass through. This is belt-and-suspenders — the fix is always at
the capture site, but the scrubber catches mistakes before they ship.

---

## 9. Privacy model

> **Three-toggle model.** The privacy contract has three toggles —
> `diagnosticsEnabled`, `applicationUsageData`, and `debug`:
>
> | Toggle                 | Gates                                                                                  | Default   |
> | ---------------------- | -------------------------------------------------------------------------------------- | --------- |
> | `diagnosticsEnabled`   | `Sentry.init`; errors, lifecycle, **metrics**, boot/sync/shutdown transactions.        | `true`    |
> | `applicationUsageData` | Permanent `user.id` hash (no monthly rotation) + the usage-tier metric dimensions (see the §9.2 table). | `false`   |
> | `debug`                | Per-RPC traces, `@comapeo/core` OTel spans, backend `consoleIntegration`, `rpc.args`.  | `false`   |
>
> Day-to-day performance signal rides an always-on **metrics** layer at
> the diagnostic tier (`comapeo.rpc.*`, `comapeo.boot.*`, etc.); per-RPC
> *traces* moved behind `debug`, which 100%-samples while on and
> auto-expires 72h after the most recent enable. `tracesSampleRate` is
> `debug ? 1.0 : <plugin rate>` where the plugin rate defaults to `0`
> (the expected production config — a nonzero rate is a build-time
> consumer decision for internal/QA builds).

CoMapeo's host-app privacy contract has three states, not two:

| Tier                              | What runs                                                                                                                                                                                                | When                                                                          |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Off**                           | Nothing. `Sentry.init` is **not** called on RN, FGS, or Node. The module's adapter stays null; emit paths no-op.                                                                                         | User explicitly opts out of diagnostic data sharing in the host app settings. |
| **Diagnostic** (default-on)       | Errors + lifecycle: `Sentry.init` runs in all three SDKs with the plugin-configured `tracesSampleRate` (`0` when unset — the expected production config), `sendDefaultPii=false`, and a PII scrubber. Boot transactions on; per-RPC spans off.                                 | Default for fresh installs (and recommended for production).                  |
| **App-usage** (additional opt-in) | Diagnostic set **plus** the usage-tier metric dimensions (RPC `method` breakdown, sync `peers_bucket`/`bytes_bucket`, app-exit exact-ms durations — see the §9.2 table), the permanent `user.id` hash, bg/fg breadcrumbs, and the SentryNativeContext fingerprinting fields. | User opts in via a settings toggle.                                           |

Diagnostic is the _baseline_; app-usage is _additive_. App-usage without
diagnostic is impossible by construction — the effective gate is
`applicationUsageData && diagnosticsEnabled`, enforced inside this
module so the host UI never has to mirror that logic.

### 9.1 The `diagnosticsEnabled` toggle

Stored in `ComapeoPrefs` (Android `SharedPreferences`, iOS
`UserDefaults`). Restart-to-activate semantics. Plugin-supplied default
via `diagnosticsEnabledDefault`.

- **Default-default**: `true`. Fresh installs ship with diagnostics on so
  baseline error visibility works out of the box. The plugin's
  `diagnosticsEnabledDefault: false` overrides this when a consumer wants
  opt-in-first behaviour.
- **JS API**:
  ```ts
  export function getDiagnosticsEnabled(): boolean;
  export function setDiagnosticsEnabled(value: boolean): Promise<void>;
  ```
  `get*` returns the user's saved value (or the default if absent);
  `set*` resolves once the value has hit disk AND (on `true → false`) the
  on-disk Sentry envelope cache has been wiped.
- **Native gating**:
  - Android `ComapeoCoreService.onCreate` — reads
    `ComapeoPrefs.open(ctx).readDiagnosticsEnabled()` before
    `SentryFgsBridge.init` and before passing `sentryConfig` to
    `NodeJSService`. When off, neither runs, so the FGS bridge stays inert
    AND the backend loader receives no `--sentry*` argv.
  - iOS `AppLifecycleDelegate.nodeService` — same shape via
    `resolveEffectiveSentryConfig()`. iOS is single-process so there's no
    separate native-init gate; the host's `Sentry.init` (owned by
    `initSentry()`) is the only init site, and it gates on the same pref.

### 9.2 The `applicationUsageData` toggle

A persisted boolean, default off, that the host app's settings UI exposes
to the end user. When on, it adds the usage-tier metric dimensions in the
table below to the always-on diagnostic set. Never unlocks anything in the
§8 never-capture list — the two layers are independent.

Front-end feature-usage recording (which screens/features a user opens) is
**not** part of this tier; that telemetry is handled by the host app via
PostHog, not Sentry. The Sentry metrics layer is for backend/native
performance and the operational dimensions below.

- **Persistence**: same `ComapeoPrefs` file. Key:
  `sentry.applicationUsageData`.
- **JS API**:
  ```ts
  export function getApplicationUsageData(): boolean;
  export function setApplicationUsageData(value: boolean): Promise<void>;
  ```
- **Plumbing**: read once at native process start, passed as a Node argv
  flag (`--applicationUsageData`). The control-socket `init` frame
  doesn't carry it. Android also reads it directly from `ComapeoPrefs` to
  gate the app-exit exact-ms fields in the FGS/main process.

#### What the tier gates

The diagnostic tier carries aggregate, low-cardinality operational signal;
`applicationUsageData` adds the dimensions that would otherwise reveal
*what a specific user does* or *how much they hold*. Per-signal:

| Signal | Tier | Why |
| --- | --- | --- |
| RPC latency, aggregate (`rpc.{client,server}.duration_ms` with `status` + device tags) | Diagnostics | Latency by status and device bucket is pure performance; no per-operation detail. |
| RPC `method` attribute on the same metrics (+ `rpc.client.send_ms{method}`) | applicationUsageData | The set and frequency of `@comapeo/core` methods a user invokes reveals what they do (create vs view vs sync) — usage behaviour, not perf. |
| Boot / shutdown phase timings + outcome | Diagnostics | Startup/teardown performance; no user-specific content. |
| Backend health gauges (memory, heap, uptime, event-loop delay) | Diagnostics | Process resource health; independent of user activity. |
| Sync session duration + outcome | Diagnostics | Sync performance/reliability is core-function health; that a sync ran is inherent to a P2P app. *Not yet wired ([#80](https://github.com/digidem/comapeo-core-react-native/issues/80)).* |
| Sync `peers_bucket` | applicationUsageData | How many devices a user syncs with is a proxy for their collaboration/social-graph size. *Not yet wired ([#80](https://github.com/digidem/comapeo-core-react-native/issues/80)).* |
| Sync `bytes_bucket` | applicationUsageData | Volume of data exchanged is a proxy for how much a user collects/shares. *Not yet wired ([#80](https://github.com/digidem/comapeo-core-react-native/issues/80)).* |
| `state.transitions` | Diagnostics | App lifecycle states; no user content. |
| `storage.size_bucket` | Diagnostics | Coarse 4-bucket dataset size — kept on so crashes/OOMs can be correlated with data volume. |
| App-exit coarse buckets (`uptime_bucket`, `bg_duration_bucket`, OEM-kill flags) | Diagnostics | Aggregate stability signal ("which OEMs kill us"); low-resolution. |
| App-exit exact-ms (`alive_for_ms`, `backgrounded_for_ms`) | applicationUsageData | Millisecond session/foreground durations are fine-grained usage-shape data. |
| `device_class` / `os_major` / `platform` tags | Diagnostics | Low-cardinality device-capability buckets; not user-identifying. |
| `ipc.errors`, `telemetry.forwarding_failures` | Diagnostics | Internal transport health. |
| Per-RPC traces / OTel spans / `rpc.args` | `debug` (separate) | Investigation-only; behind the 72h auto-off `debug` toggle, not `applicationUsageData`. |

#### Why restart-to-activate

1. **Snapshot-at-boot semantics.** The flag's value is read once, at
   process start, and embedded in argv to the loader. The backend wires
   its `onRequestHook`, OTel sampler, and custom span emitters based on
   that snapshot. Hot-toggling would mean re-registering hooks on a live
   RPC server, which adds a class of bugs (in-flight requests with one
   instrumentation, new requests with another) for marginal value.
2. **Predictable user expectation.** The user toggling "capture more data
   for debugging" should reasonably expect a clear before/after, not a
   partial transition in the middle of an active sync session.

#### Cross-toggle interaction

Setters write their raw values independently. The _effective_
`applicationUsageData` value is always
`stored && diagnosticsEnabled` — internal gate only. The user's stored
`applicationUsageData=true` is preserved across diagnostics off→on
cycles.

#### What the toggle never unlocks

The §8 never-capture list applies regardless:

- The toggle does not raise `rpcArgsBytes` from 0; raw RPC args remain
  off. (`rpcArgsBytes` is a separate **build-time** config-plugin option
  for developer debug builds.)
- The toggle does not start capturing observation contents.
- The toggle does not start capturing precise location.
- The toggle does not start capturing peer identities.

#### Sentry `user.id`

Identity is anchored on a **root user ID** — a short random code
(`XXXX-XXXX-XXXX`, 12 chars from a base32 alphabet with no I/L/O/U, 60
bits) generated lazily on first read and persisted in `ComapeoPrefs`
(SharedPreferences / UserDefaults, so uninstall genuinely resets
identity). The format is deliberately short and unambiguous so a user
can hand-copy it from a screen for a support case. The root ID itself
is **never sent to Sentry**; every event's `user.id` is a hash derived
from it natively (`SentryUserId.{kt,swift}`,
`sha256("<root>|<salt>")` hex, first 16 chars):

- `applicationUsageData` **off** → salt is the current UTC `YYYY-MM`,
  so the ID rotates monthly and cross-month events can't be linked to
  one install.
- `applicationUsageData` **on** → salt is the constant `"permanent"`,
  so the ID is stable across launches and months (cohort analysis
  works). Restart-to-activate, like the toggle itself.

Because both derivations are recomputable from the root ID, a user can
share it (surfaced via `getRootUserId()` from the `/sentry` sub-export,
intended for a debug/about screen) and support can re-associate their
historical events — including pre-opt-in monthly IDs.

One launch reports one user: native derives the value once per process
start and distributes it to all three SDKs — `Sentry.setUser` on the RN
side (via the `sentryConfig.userId` constant), scope user on the native
init (`SentryFgsBridge.init` / `SentryNativeBridge.initFromConfig`), and
`--sentryUserId` argv to the backend's `initialScope`.

### 9.3 Module ownership of `Sentry.init`

`@comapeo/core-react-native/sentry` owns the RN-side `Sentry.init` call.
The host calls a single `initSentry(options?)` at app entry; the module
reads its prefs and the plugin-supplied `sentryConfig` and either:

- skips `Sentry.init` entirely (diagnostics off, or no DSN);
- throws if the host called `Sentry.init` themselves (clear migration
  error pointing at `initSentry`); or
- calls `Sentry.init` with locked options + allowlisted host extensions.

`initSentry` is idempotent: a second call is a no-op. The host can't
fully avoid a second call because a JS-bundle reload (dev fast-refresh,
or an OTA update swapping the bundle) re-runs the entry point while the
Sentry SDK from the first run is still alive — re-running `Sentry.init`
there would replace a live client mid-flight. The re-entry is told apart
from a host's own `Sentry.init` by a `globalThis` ownership marker that
shares fate with the SDK's own global carrier: SDK up **with** our marker
→ benign reload, skip; SDK up **without** it → the host's foreign init,
migration error. Options passed to a second call are ignored (the client
is already configured); changing configuration requires a full app
restart. There's deliberately no config-diff check on re-entry — the only
host-supplied options are functions (`integrations`, `beforeSend`,
`beforeBreadcrumb`), whose identities differ on every reload, so a
comparison would false-positive on the exact reload it's meant to allow.

```ts
// Host's app entry:
import * as Sentry from "@sentry/react-native";
import { initSentry } from "@comapeo/core-react-native/sentry";

initSentry({
  integrations: (defaults) => [...defaults, navIntegration],
  beforeSend: hostBeforeSend, // chained AFTER our scrubber
  beforeBreadcrumb: hostBeforeBreadcrumb,
  tags: { app: "comapeo-mobile" },
});
```

Locked options (the host's `InitSentryOptions` type does **not** include
them — TypeScript refuses them at the call site):

- `dsn`, `release`, `environment`, `sampleRate`, `enableLogs` — from the
  plugin's `sentryConfig`.
- `tracesSampleRate` — `1.0` while the `debug` window is on, otherwise
  the plugin's value (`0` when unset). Effective gate enforced here.
- `sendDefaultPii: false` — non-overridable.
- `user.id` — controlled by the module: the native-derived
  monthly/permanent hash (see §9.2's "Sentry `user.id`").

The `integrations` option is a function `(defaults) => Integration[]` so
the host can append to (not replace) our defaults. `beforeSend` and
`beforeBreadcrumb` chain: our scrubber runs first; if it drops the
event/crumb, the host's hook never sees it.

### 9.4 Outbox wipe on toggle-off

Setters that transition `true → false` call
`ComapeoPrefs.wipeSentryOutbox(context)` synchronously after the prefs
write commits. The wipe is a filesystem `deleteRecursively` against the
documented sentry-android (`<cacheDir>/sentry/`) / sentry-cocoa
(`<NSCachesDirectory>/io.sentry/`) cache root. Pending envelopes (events
queued from the current session but not yet sent), session-tracking
state, and on-disk scope all go in one shot.

The current process keeps emitting in-memory until the next launch
(restart-to-activate is unchanged) but those emissions land in an outbox
the wipe just cleared, so the next-launch SDK won't have anything to
upload — and the next launch won't init Sentry at all because the prefs
read returns the new value. Best-effort: a filesystem error never blocks
the privacy opt-out.

### 9.5 Default and migration

Per-environment, decided by the consumer at build time via plugin fields:

```json
{
  "expo": {
    "plugins": [
      [
        "@comapeo/core-react-native",
        {
          "sentry": {
            "dsn": "...",
            "environment": "development",
            "diagnosticsEnabledDefault": true,
            "applicationUsageDataDefault": true
          }
        }
      ]
    ]
  }
}
```

Recommended consumer config, wired through EAS env vars:

```js
// app.config.js
applicationUsageDataDefault:
  (process.env.SENTRY_ENVIRONMENT ?? "production") !== "production",
```

so internal/test builds opt in by default without any user action, while
production ships off-by-default. If a field is omitted, native treats it
as `false` everywhere — safer fallback for the example app and any
consumer that doesn't actively configure it.

Once the user flips the switch in the host app's settings UI, their
explicit choice wins forever — the per-build default only applies on the
first launch after install (or after a clear-data).
