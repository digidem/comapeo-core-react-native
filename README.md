# @comapeo/core-react-native

Embeds [CoMapeo Core](https://github.com/digidem/comapeo-core) in a React Native
app. The core runs inside a bundled Node.js runtime (nodejs-mobile) in a
background process; this package exposes an RPC client to talk to it, lifecycle
and permission helpers, an offline map server, and an Expo config plugin that
wires up the native build.

The package ships native code, so it does not run in Expo Go — you need a
development build (or a bare project with the native changes applied).

## Requirements

- Expo SDK 56 (the package is built and tested against it).
- `@sentry/react-native` is a peer dependency and must be installed. Sentry
  stays inert at runtime unless you configure it (see [Sentry](#sentry)).
- Node 24 to build the package from source.

## Installation

### Expo project

```
npx expo install @comapeo/core-react-native @sentry/react-native
```

Add the config plugin in `app.json` / `app.config.js`:

```json
{
  "expo": {
    "plugins": ["@comapeo/core-react-native"]
  }
}
```

Then create a development build:

```sh
npx expo prebuild
npx expo run:android   # or: npx expo run:ios
```

The plugin runs during `prebuild` and applies the required native config (see
[Config plugin](#config-plugin)). Pass options as the second element of the
plugin array.

### Bare React Native project

First [install and configure `expo`
modules](https://docs.expo.dev/bare/installing-expo-modules/), then:

```
npm install @comapeo/core-react-native @sentry/react-native
npx pod-install   # iOS
```

The config plugin only runs under `expo prebuild`. If you don't use prebuild,
apply its native changes by hand:

- Allow cleartext HTTP to loopback only — an Android
  `network-security-config` scoped to `127.0.0.1`/`localhost`, and the iOS
  `NSAllowsLocalNetworking` ATS key. The map server runs as plain HTTP on
  loopback, which release builds otherwise block.
- Add the Sentry library-evolution Podfile hook
  (`BUILD_LIBRARY_FOR_DISTRIBUTION = YES` for `Sentry*` pods) inside your
  `post_install` block.
- See [Android backup rules](#android-backup-rules) for a manifest-merger
  conflict you may hit.

## Usage

The native module starts and supervises the embedded backend on its own — an
Android foreground service, and the app lifecycle on iOS. You observe it through
`state` and talk to it through `comapeo` once it has started.

### `state` — lifecycle

```ts
import { state } from "@comapeo/core-react-native";

state.getState(); // "STOPPED" | "STARTING" | "STARTED" | "STOPPING" | "ERROR"

const sub = state.addListener("stateChange", (next, error) => {
  if (next === "STARTED") {
    // RPC is safe to use.
  }
  if (next === "ERROR" && error) {
    console.warn(error.errorPhase, error.errorMessage);
  }
});
// sub.remove() when done
```

- `getState()` — current lifecycle state.
- `getLastError()` — structured detail from the most recent `ERROR`, or `null`.
- `"stateChange"` — fires on every transition; the second argument carries
  `{ errorPhase, errorMessage }` on `ERROR`, otherwise `null`.
- `"messageerror"` — fires (with an `Error`) when the backend sends a control
  frame the native side can't parse. It does not change the lifecycle state;
  useful for debugging only.

On `ERROR` the native layer leaves the backend process in place — recovery is
up to the app (restart the service, prompt the user, log a report).

### `comapeo` — CoMapeo Core RPC

`comapeo` is the [`@comapeo/ipc`](https://github.com/digidem/comapeo-core)
client for CoMapeo Core (the `MapeoManager` API: projects, observations, sync,
etc.).

You don't have to wait for `STARTED` to call it. Calls made before the backend
is ready are buffered and resolve once it starts. Every call has a 30s timeout,
so a call that gets no answer — the backend failed to boot, hit `ERROR`, or the
process isn't running — rejects rather than hanging (in-flight calls may reject
sooner when the transport closes). On `ERROR` the backend is not restarted
automatically; observe `state` and recover as appropriate.

```ts
import { comapeo } from "@comapeo/core-react-native";

const projectId = await comapeo.createProject({ name: "My project" });
const project = await comapeo.getProject(projectId);
```

See the CoMapeo Core / `@comapeo/ipc` documentation for the full method surface.

### `comapeoServicesClient` — app services

RPC client for services the app provides to the backend. Today its only member
is the map server:

```ts
import { comapeoServicesClient } from "@comapeo/core-react-native";

const baseUrl = await comapeoServicesClient.mapServer.getBaseUrl();
// → http://127.0.0.1:<port>
```

### Notification permission (Android 13+)

The foreground service posts an ongoing notification. On Android 13+ (API 33)
posting it needs the runtime `POST_NOTIFICATIONS` grant; without it the system
suppresses the notification and may deprioritise the service. The module
declares the permission and exposes check/request helpers so you don't have to
add `expo-notifications` for this alone:

```ts
import {
  getNotificationPermissionsAsync,
  requestNotificationPermissionsAsync,
} from "@comapeo/core-react-native";

const current = await getNotificationPermissionsAsync();
if (!current.granted && current.canAskAgain) {
  await requestNotificationPermissionsAsync();
}
```

Both resolve an expo-style `PermissionResponse`
(`{ status, granted, canAskAgain, expires }`), interchangeable with
`expo-camera`, `expo-location`, etc. On Android < 13 and on iOS they resolve as
`granted` without a dialog, so you can call them unconditionally.

The module never prompts on its own — you decide when to ask and own the
rationale and the "open settings" fallback once `canAskAgain` is `false`.
Starting the service does not require the grant: if it's missing, the service
still starts (without a visible notification). If you already request
`POST_NOTIFICATIONS` via `expo-notifications`, you don't need these helpers. See
[`docs/ForegroundService.md`](docs/ForegroundService.md) for the rationale.

## Map Server

The backend runs an offline-capable map server
([`@comapeo/map-server`](https://www.npmjs.com/package/@comapeo/map-server))
over loopback HTTP. Point a renderer such as [MapLibre](https://maplibre.org/)
at the local URL to draw background maps, including offline.

```ts
const baseUrl = await comapeoServicesClient.mapServer.getBaseUrl();
const styleUrl = `${baseUrl}/maps/fallback/style.json`;
```

Three map IDs are served under `/maps/<id>/…`:

- `fallback` — a small offline map bundled with the module
  (`@comapeo/fallback-smp`); always available.
- `default` — redirects to the configured online style (see
  `defaultOnlineStyleUrl`), so it needs a network connection.
- `custom` — an offline `.smp` imported through the app; returns 404 until one
  is added.

## Config plugin

Register the plugin and pass options as the second array element:

```js
// app.config.js
export default {
  expo: {
    plugins: [
      ["@comapeo/core-react-native", {
        defaultConfig: "./assets/categories.comapeocat",
        defaultOnlineStyleUrl: "https://example.com/style.json",
      }],
    ],
  },
};
```

Options are baked in at `prebuild`, so changing any of them requires a new
prebuild and build. Regardless of options, the plugin always adds the
loopback-only cleartext exception (so the map server is reachable), the iOS
local-network usage description (so peer sync works — see
[`localNetworkPermission`](#localnetworkpermission)), and, on iOS, the Sentry
library-evolution Podfile hook.

### `defaultConfig`

Path to a `.comapeocat` file bundled into the app and applied to every project
created without an explicit config. The path is resolved relative to your
project root. Omit it and new projects start with no presets/categories. Use
[`@comapeo/default-categories`](https://www.npmjs.com/package/@comapeo/default-categories)
(or your own build) as the source — this module does not ship one.

If you set `defaultConfig` and later remove it, run a clean prebuild
(`expo prebuild --clean`) so the stale file is dropped from the iOS project; a
non-clean prebuild leaves the reference behind.

### `defaultOnlineStyleUrl`

The online map style used as a fallback when no offline map is available. Must
be an `http(s)` URL. Defaults to MapLibre's demo tiles
(`https://demotiles.maplibre.org/style.json`).

### `localNetworkPermission`

The iOS Local Network usage description shown when the app first connects to
peers on the local network for sync. Defaults to a generic string. Override it
to localise or reword the prompt:

```js
["@comapeo/core-react-native", {
  localNetworkPermission: "MyApp connects to nearby devices to sync your data.",
}];
```

The plugin owns the `NSLocalNetworkUsageDescription` key, so set the wording here
rather than in your own Info.plist or it will be overwritten. mDNS/Bonjour
discovery stays your app's responsibility: this module currently neither browses nor
advertises services, so if your app does, add the matching `NSBonjourServices`
entries yourself. Android needs nothing — its cleartext/network-security config
doesn't gate the Node thread's sockets, and there's no equivalent permission.

### `sentry` options

Opt into Sentry by passing a `sentry` object (see [Sentry](#sentry) for the
full integration). All values are written into AndroidManifest meta-data and
Info.plist keys at prebuild.

| Key | Required | Description |
| --- | --- | --- |
| `dsn` | yes | Sentry DSN. Source from `process.env` so EAS profiles produce different builds (requires `app.config.js`, not `app.json`). |
| `environment` | yes | Sentry environment (e.g. `production`, `staging`). |
| `release` | no | Release tag. Defaults to the app's version (`versionName`+`versionCode` / `CFBundleShortVersionString`+`CFBundleVersion`). |
| `sampleRate` | no | Error sample rate (0–1). |
| `tracesSampleRate` | no | Performance trace sample rate. Default 0.1 when capture-application-data is on; 0 when off. |
| `rpcArgsBytes` | no | Max bytes of RPC arguments captured on spans. |
| `diagnosticsEnabledDefault` | no | Fresh-install default for the diagnostics toggle. |
| `captureApplicationDataDefault` | no | Fresh-install default for the capture-application-data toggle. Keep off in production. |
| `enableLogs` | no | Forward Sentry structured logs from the backend process. Pair with `enableLogs: true` in your host `Sentry.init` setup. |

Omitting `sentry` (or removing it on a re-prebuild) strips all keys this plugin
owns, leaving any keys other plugins wrote in place.

## Sentry

Optional. The module can forward its native and JS lifecycle events into the
host app's `@sentry/react-native`. It owns the RN-side `Sentry.init` call, so
the host wires Sentry through this module rather than initialising it directly.

### Setup

1. Configure the plugin's `sentry` option with at least `dsn` and
   `environment` (see [`sentry` options](#sentry-options)).
2. Initialise once at app entry — do **not** call `Sentry.init` yourself:

```ts
import { initSentry } from "@comapeo/core-react-native/sentry";
import * as Sentry from "@sentry/react-native";

initSentry({
  integrations: (defaults) => [...defaults, Sentry.reactNavigationIntegration()],
  beforeSend: (event) => event, // runs after the module's scrubber
  tags: { releaseChannel: "internal" },
});
```

`initSentry` reads the plugin-baked DSN, environment, release, and sample rates
and wires the RN, Node, and Android-FGS sides to the same values. Locked options
(`dsn`, `release`, `environment`, `sampleRate`, `tracesSampleRate`,
`sendDefaultPii: false`, `enableLogs`, `user.id`) come from the plugin and can't
be overridden — TypeScript rejects them at the call site. It throws if the host
called `Sentry.init` separately, and is a no-op if diagnostics are disabled or
no DSN was baked in.

### Sub-export API

From `@comapeo/core-react-native/sentry`:

- `initSentry(options?)` — initialise Sentry. Call once.
- `sentryConfig` — read-only view of the plugin-baked options (empty `{}` when
  the plugin isn't configured). For inspection only; don't spread it into a
  separate `Sentry.init`.
- `getDiagnosticsEnabled()` / `setDiagnosticsEnabled(value)` — the diagnostics
  opt-out toggle. Restart-to-activate; setting `false` also wipes the on-disk
  envelope cache.
- `getCaptureApplicationData()` / `setCaptureApplicationData(value)` — the
  capture-application-data toggle (gates traces and richer payloads).

### Sourcemaps

The Node backend ships minified, so upload its sourcemaps for readable stack
traces. The sourcemaps carry content-hashed Sentry debug IDs, so you don't need
to align this module's version with your app's release:

```sh
SENTRY_AUTH_TOKEN=… npx comapeo-rn-upload-sourcemaps \
  --org your-org --project your-project
```

Re-uploading is idempotent (Sentry de-dupes by debug ID). The CLI finds
`@sentry/cli` via `@sentry/react-native`'s dependency chain. `--targets <list>`
restricts the upload to a subset of `android-debug, android-main, ios`; `--url`
points at self-hosted Sentry; `SENTRY_ORG` / `SENTRY_PROJECT` work in place of
the flags.

See [`docs/sentry-integration-plan.md`](./docs/sentry-integration-plan.md) for
the design and [`docs/ARCHITECTURE.md` §7](./docs/ARCHITECTURE.md) for the
overview.

## Android backup rules

The module's `AndroidManifest.xml` sets `android:dataExtractionRules` and
`android:fullBackupContent` to exclude the rootkey-bearing SharedPreferences
from cloud backup and device-to-device transfer. The rootkey is wrapped by a
device-bound AndroidKeyStore key, so a backed-up copy is useless on another
device; excluding it avoids a confusing restore-then-fail flow.

If your app already declares either attribute, the manifest merger fails with a
"different value declared" error. To resolve it:

1. Merge the module's exclusions into your own rules XML — add
   `<exclude domain="sharedpref" path="comapeo-core.xml" />` under both
   `<cloud-backup>` and `<device-transfer>` in your `dataExtractionRules`, and
   the same under `<full-backup-content>` in your `fullBackupContent`. The
   module's defaults are in
   [`android/src/main/res/xml/`](android/src/main/res/xml/) for reference.
2. Add `tools:replace="android:dataExtractionRules,android:fullBackupContent"`
   to your app's `<application>` tag.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup, tests, and
commit/PR/release conventions, and [AGENTS.md](./AGENTS.md) for the
architecture and a directory-by-directory breakdown.
