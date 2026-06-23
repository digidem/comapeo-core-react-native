# @comapeo/core-react-native

CoMapeo Core for React Native

# API documentation

- [Documentation for the latest stable release](https://docs.expo.dev/versions/latest/sdk/@comapeo/core-react-native/)
- [Documentation for the main branch](https://docs.expo.dev/versions/unversioned/sdk/@comapeo/core-react-native/)

# Installation in managed Expo projects

For [managed](https://docs.expo.dev/archive/managed-vs-bare/) Expo projects, please follow the installation instructions in the [API documentation for the latest stable release](#api-documentation). If you follow the link and there is no documentation available then this library is not yet usable within managed projects &mdash; it is likely to be included in an upcoming Expo SDK release.

# Installation in bare React Native projects

For bare React Native projects, you must ensure that you have [installed and configured the `expo` package](https://docs.expo.dev/bare/installing-expo-modules/) before continuing.

### Add the package to your npm dependencies

```
npm install @comapeo/core-react-native
```

### Configure for Android

#### Backup-rules merge conflict (manifest-merger)

The library's `AndroidManifest.xml` sets two `<application>` attributes
that exclude the rootkey-bearing SharedPreferences from cloud backup
and device-to-device transfer:

```xml
<application
    android:dataExtractionRules="@xml/comapeo_data_extraction_rules"
    android:fullBackupContent="@xml/comapeo_backup_rules">
```

If your host app's `AndroidManifest.xml` already declares either
attribute (a fairly common case in shipping apps), the manifest merger
will fail at build time with a "different value declared" error. The
fix is two steps:

1. **Merge our exclusions into your existing rules XML.** Add an
   `<exclude domain="sharedpref" path="comapeo-core.xml" />` entry
   under both `<cloud-backup>` and `<device-transfer>` in your
   `dataExtractionRules` resource, and the same `<exclude>` under
   `<full-backup-content>` in your `fullBackupContent` resource. The
   library's defaults are at
   [`android/src/main/res/xml/comapeo_data_extraction_rules.xml`](android/src/main/res/xml/comapeo_data_extraction_rules.xml)
   and
   [`android/src/main/res/xml/comapeo_backup_rules.xml`](android/src/main/res/xml/comapeo_backup_rules.xml)
   for reference.

2. **Tell the merger that your manifest wins.** Add `tools:replace` to
   your app's `<application>` tag:

   ```xml
   <application
       xmlns:tools="http://schemas.android.com/tools"
       android:dataExtractionRules="@xml/your_app_extraction_rules"
       android:fullBackupContent="@xml/your_app_backup_rules"
       tools:replace="android:dataExtractionRules,android:fullBackupContent">
   ```

#### Why the exclusion matters

The rootkey is encrypted with a wrapper key from AndroidKeyStore.
That wrapper key is device-bound and non-exportable, so a backed-up
envelope is useless on any other device. The exclusion is
defense-in-depth (the encrypted blob shouldn't sit in cloud backups
even when it's useless to attackers) and UX (without the exclusion,
restore-to-new-device flows appear to succeed but then fail at first
launch with `RootKeyException("Wrapper key alias missing")`, which
is a confusing state to end up in).

### Configure for iOS

Run `npx pod-install` after installing the npm package.

# Map server

The module runs an offline-capable map server (`@comapeo/map-server`)
inside the embedded Node backend, served over loopback HTTP. Point a map
renderer such as [MapLibre](https://maplibre.org/) at the local URL to
draw background maps — including offline.

```ts
import { comapeoServicesClient } from "@comapeo/core-react-native";

// Available once the backend has started.
const baseUrl = await comapeoServicesClient.mapServer.getBaseUrl();
// → http://127.0.0.1:<port>

// Hand a style URL to your map renderer:
const styleUrl = `${baseUrl}/maps/fallback/style.json`;
```

Three built-in map IDs are served under `/maps/<id>/…`:

- **`fallback`** — a small offline map bundled with the module
  (`@comapeo/fallback-smp`); always available, used as the last resort.
- **`default`** — redirects to a hardcoded online style
  (`demotiles.maplibre.org`), so it needs a network connection.
- **`custom`** — an offline `.smp` the user has imported through the
  app; returns 404 until one is added.

`comapeoServicesClient` is the client for the app-provided services RPC
(renamed from `appRpcClient` in `@comapeo/ipc@9`); `mapServer` is its
only member today.

### Cleartext-to-localhost

The map server is plain HTTP on `127.0.0.1`, which release builds block
by default. The Expo config plugin adds a **loopback-scoped** exception
so the server is reachable: an Android `network-security-config` limited
to `127.0.0.1`/`localhost`, and the iOS `NSAllowsLocalNetworking` ATS
key. Traffic to the public internet keeps the secure default. If your
app manages its own `networkSecurityConfig` or App Transport Security
settings, make sure cleartext to loopback stays allowed.

# Notification permission (Android 13+)

The foreground service posts an ongoing notification so the user can see the
backend is running. On Android 13+ (API level 33) posting it requires the
runtime `POST_NOTIFICATIONS` grant; without it the system **suppresses** the
notification, which lets Android deprioritise or kill the service sooner. The
module declares the permission and exposes check/request helpers, so you don't
have to add `expo-notifications` just to grant the foreground-service
notification:

```ts
import {
  getNotificationPermissionsAsync,
  requestNotificationPermissionsAsync,
} from "@comapeo/core-react-native";

// Check without prompting.
const current = await getNotificationPermissionsAsync();

// Prompt only if we still can.
if (!current.granted && current.canAskAgain) {
  const result = await requestNotificationPermissionsAsync();
  // result.canAskAgain === false → user picked "Don't ask again";
  //   show your own rationale and deep-link them to app settings.
}
```

Both resolve an expo-style `PermissionResponse`
(`{ status, granted, canAskAgain, expires }`), interchangeable with permissions
from `expo-camera`, `expo-location`, etc. On Android < 13 and on iOS they
resolve as `granted` without a dialog, so host code can call them
unconditionally without branching on platform.

**The module never prompts on its own.** You decide when to ask and own the UX
around it — the rationale copy and the "open settings" fallback once
`canAskAgain` is `false`. Starting the service does **not** require the grant:
if it's missing, the service still starts and degrades gracefully (no visible
notification, possible deprioritisation) rather than failing. If your app
already requests `POST_NOTIFICATIONS` through `expo-notifications`, you don't
need these helpers. See
[`docs/ForegroundService.md`](docs/ForegroundService.md) for the full
rationale.

# Default project config

New projects are created with no presets/categories unless you supply a
default config. Pass a `.comapeocat` file to the Expo config plugin; it
gets bundled into the app and applied to every project created without an
explicit config:

```js
// app.config.js / app.json plugins
[
  "@comapeo/core-react-native",
  {
    defaultConfig: "./assets/my-categories.comapeocat",
  },
]
```

The path is resolved relative to your app's project root. Omit
`defaultConfig` and new projects start empty. Use
[`@comapeo/default-categories`](https://www.npmjs.com/package/@comapeo/default-categories)
(or your own build) as the source `.comapeocat` — this module no longer
ships one.

If you later **remove** `defaultConfig` after having set it, run a clean
prebuild (`expo prebuild --clean`) so the bundled file is dropped from the
iOS Xcode project; a non-clean prebuild leaves the stale reference behind.

# Online map style

Maps fall back to an online style when no offline map is available. The
default is MapLibre's demo tiles (`https://demotiles.maplibre.org/style.json`).
Override it by passing `defaultOnlineStyleUrl` to the Expo config plugin:

```js
// app.config.js / app.json plugins
[
  "@comapeo/core-react-native",
  {
    defaultOnlineStyleUrl: "https://example.com/style.json",
  },
]
```

Omit it to keep the default. The value is baked in at prebuild, so changing
it requires a new prebuild + build.

# Optional: Sentry integration

This module can forward its native-side and JS-side lifecycle events
into the host app's `@sentry/react-native`. Sentry is opt-in — if you
don't register the plugin and don't import the sub-export, no Sentry
code path is exercised and no DSN ends up in your APK/IPA. See
[`docs/ARCHITECTURE.md` §7](./docs/ARCHITECTURE.md) for the
architectural overview and
[`docs/sentry-integration-plan.md`](./docs/sentry-integration-plan.md)
for the design plan and per-phase status.

### 1. Install `@sentry/react-native` in your app

`@sentry/react-native` is an optional peer dep of this module. Install
it in the host app and run `Sentry.init(...)` once at startup as
documented at <https://docs.sentry.io/platforms/react-native/>. The
runtime classes shipped with `@sentry/react-native` also satisfy the
Android FGS-process bridge — no extra Android dependency to declare.

### 2. Register the Expo config plugin

In `app.config.js` (must be `.js`, not `app.json`, to read `process.env`):

```js
export default {
  expo: {
    plugins: [
      ["@comapeo/core-react-native", {
        sentry: {
          dsn: process.env.SENTRY_DSN,
          environment: process.env.SENTRY_ENVIRONMENT ?? "production",
          // Optional: opt internal/test builds into the §9 capture-application-data
          // toggle by default. Production stays off-by-default.
          captureApplicationDataDefault:
            (process.env.SENTRY_ENVIRONMENT ?? "production") !== "production",
          // Optional: opt into Sentry structured logs on the
          // Android FGS process. Pair with `enableLogs: true` in
          // your host-app `Sentry.init(...)` (covers main-process
          // Android + iOS).
          enableLogs: process.env.SENTRY_ENVIRONMENT !== "production",
        },
      }],
    ],
  },
};
```

The plugin runs at `expo prebuild` and bakes the DSN, environment, and other
options into AndroidManifest meta-data and Info.plist keys. Sourcing values
from `process.env` lets EAS build profiles produce different builds without
code changes — see
[`docs/sentry-integration-plan.md` §4.1](./docs/sentry-integration-plan.md)
for the matching `eas.json` example with per-profile env vars.

### 3. Import the sub-export

```ts
import "@comapeo/core-react-native/sentry";
```

That's it — importing the sub-export attaches the lifecycle listeners
to the host's already-initialised Sentry hub. No explicit handoff
call. As long as the host has run `Sentry.init(...)` (the
`@sentry/react-native` SDK reads its DSN from the same Info.plist /
manifest values your plugin wrote), errors and breadcrumbs flow
automatically. ERROR state transitions surface tagged with the
relevant phase (`rootkey`, `starting-timeout`,
`node-runtime-unexpected`, etc.); state transitions show up as
breadcrumbs that ride along on the next event.

### 3a. Initialise Sentry via `initSentry`

This module owns the RN-side `Sentry.init` call. Do NOT call
`Sentry.init` yourself — call `initSentry()` once at app entry
and pass any allowlisted extensions through it:

```ts
import { initSentry } from "@comapeo/core-react-native/sentry";
import * as Sentry from "@sentry/react-native";

initSentry({
  // Optional — append your own integrations to the defaults.
  integrations: (defaults) => [
    ...defaults,
    Sentry.reactNavigationIntegration(),
  ],
  // Optional — runs AFTER this module's PII scrubber.
  beforeSend: (event) => event,
  // Optional — extra scope tags on the persistent global scope.
  tags: { releaseChannel: "internal" },
});
```

`initSentry` reads the plugin-baked DSN / environment / release /
sample rates from the native config and wires the RN, Node, and
Android-FGS hubs to the same values, so events from all three sides
land under one release / environment. Locked options (`dsn`,
`release`, `environment`, `sampleRate`, `tracesSampleRate`,
`sendDefaultPii: false`, `enableLogs`, `user.id`) come from the
plugin and can't be overridden by the host — TypeScript refuses them
at the call site. `initSentry` throws if the host already called
`Sentry.init` separately.

The same plugin-baked subset is also exported as `sentryConfig`
(empty `{}` when the plugin isn't registered) for read-only
inspection — e.g. logging which release the host is reporting under,
or rendering it in a debug screen — but it is NOT meant to be spread
into a separate `Sentry.init` call; `initSentry` is the supported
init entrypoint.

### What gets captured automatically

Once the plugin is registered with a `dsn`, the module captures
events from three layers, tagged for filtering in the dashboard:

- **`layer:rn`** (JS adapter, auto-attached when the sub-export
  is imported) — state-machine ERROR transitions and
  `messageerror` parse failures; every state transition rides
  along as a breadcrumb.
- **`layer:native`** (Kotlin / Swift) — `comapeo.boot` transaction
  (root, force-sampled) with child spans `boot.fgs-launch`
  (Android only — `startForegroundService` → FGS process ready),
  `boot.extract-assets` (Android only, first boot after install/
  update — recursive copy of `nodejs-project/` from APK assets to
  internal storage; iOS reads the bundle in place so no equivalent),
  `boot.node-spawn` (nodejs-mobile JNI call → control `started`),
  `boot.rootkey-load`, and `boot.init-frame`. Plus
  state-transition breadcrumbs, control-frame breadcrumbs,
  watchdog/shutdown timeout events, rootkey-load
  `captureException`. On Android adds FGS-lifecycle breadcrumbs.
- **`layer:node`** — `boot.loader-init` (process spawn → Sentry.init
  done), `boot.import-index` (around `import("./index.js")`),
  `boot.listen-control` (control-socket bind), `boot.manager-init`
  (drizzle + SQLite + RPC bind), plus per-RPC method spans,
  `handleFatal` exceptions, and `error-native` forwards from the
  embedded nodejs-mobile. Node-side spans inherit the FGS-side
  trace via `Sentry.continueTrace` on the `boot.node-spawn` span
  ID forwarded as the `--sentryTrace` argv flag.
  `@sentry/node` has no offline transport, so its envelopes are
  forwarded over the control socket to the FGS-side
  `sentry-android` (or sentry-cocoa on iOS) for queueing and send.
  Error events are deserialised into a `SentryEvent` and captured
  via `Sentry.captureEvent`, which applies the native SDK's scope
  (device, OS, app, user, native breadcrumbs) at capture time so
  Node-emitted events end up with the same context as RN-side
  captures.

Each event also carries a `proc` tag for the *actual* OS process:
`proc:main` for everything on iOS (single-process), and
`proc:main` (RN code) or `proc:fgs` (anything in
`:ComapeoCore` — both the Kotlin FGS service and the embedded
nodejs-mobile) on Android.

The FGS-process Sentry SDK is initialised automatically in
`ComapeoCoreService.onCreate` from the manifest meta-data your
config plugin wrote. There's no extra configuration required for
multi-process Android apps using this module — that's the
`SentryFgsBridge` doing the work behind the scenes. If
`@sentry/react-native` isn't installed (so `io.sentry.*` isn't on
the runtime classpath), the bridge stays inert and the module
continues to function unchanged.

### 4. Upload backend sourcemaps to your Sentry project

The Node-backend bundle (the `loader.mjs` spawn target plus its
dynamically-imported `index.mjs`, the `import-in-the-middle` hook
files, and the auto-emitted `@sentry/node` chunks) ships rolled-up +
minified, so without sourcemaps stack traces in Sentry are unreadable.
The bundle's sourcemaps ship inside the npm tarball with deterministic,
content-hashed [Sentry debug IDs][] baked in at build time —
symbolication is keyed off the IDs, so you do *not* have to align this
module's version with your app's `release`.

Add one step to your release pipeline (after `eas build`, or as part
of the build's post-publish phase):

```sh
SENTRY_AUTH_TOKEN=… npx comapeo-rn-upload-sourcemaps \
  --org   your-org \
  --project your-project
```

Re-uploading is idempotent: Sentry de-dupes by debug ID. The CLI
finds `@sentry/cli` via the transitive `@sentry/react-native` →
`@sentry/cli` chain in your `node_modules`; if you don't use
`@sentry/react-native`, add `@sentry/cli` to your devDeps yourself.

`--targets <list>` (default: all) restricts the upload to a subset of
`android-debug, android-main, ios`. `--url` points at a self-hosted
Sentry. `SENTRY_ORG` / `SENTRY_PROJECT` env vars work in place of the
flags.

[Sentry debug IDs]: https://docs.sentry.io/platforms/javascript/sourcemaps/troubleshooting_js/debug-ids/

# Contributing

Contributions are very welcome! See [CONTRIBUTING.md](./CONTRIBUTING.md) for the
development setup, how to run the tests, and the commit/PR/release conventions.
For the architecture and a directory-by-directory breakdown see
[agents.md](./agents.md).
