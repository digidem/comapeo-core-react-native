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

### 3a. Align the release on both sides

The Node-backend hub (`@sentry/node` running inside nodejs-mobile)
and the host RN hub (`@sentry/react-native`) are independent — for
cross-side correlation they must use the same `release`. Pass the
plugin-baked value to your host init:

```ts
import { getSentryRelease } from "@comapeo/core-react-native/sentry";
import * as Sentry from "@sentry/react-native";

Sentry.init({
  release: getSentryRelease() ?? undefined,
  // ...
});
```

`getSentryRelease()` returns the `release` value the plugin wrote
into the manifest / plist (default: `versionName+versionCode` on
Android, `CFBundleShortVersionString+CFBundleVersion` on iOS, or
whatever you set with `sentry.release` in your plugin args). The
backend already gets the same value via `--sentryRelease`.

### What gets captured automatically

Once the plugin is registered with a `dsn`, the module captures
events from three layers, tagged for filtering in the dashboard:

- **`layer:rn`** (JS adapter, auto-attached when the sub-export
  is imported) — state-machine ERROR transitions and
  `messageerror` parse failures; every state transition rides
  along as a breadcrumb.
- **`layer:native`** (Kotlin / Swift) — `comapeo.boot`
  transaction with phase spans (`boot.rootkey-load`,
  `boot.init-frame`), state-transition breadcrumbs,
  control-frame breadcrumbs, watchdog/shutdown timeout events,
  rootkey-load `captureException`. On Android adds FGS-lifecycle
  breadcrumbs.
- **`layer:node`** — RPC method spans, `handleFatal` exceptions,
  and `error-native` forwards from the embedded nodejs-mobile,
  with device/os/app/culture context forwarded from native at
  init time so events look the same as RN-side captures.

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

Contributions are very welcome! Please refer to guidelines described in the [contributing guide](https://github.com/expo/expo#contributing).

## Repository layout

The repo is a single npm package with two consumers:

- **`src/`, `android/`, `ios/`** — the published `@comapeo/core-react-native` module. This is what installs into a consumer's app via `npm install @comapeo/core-react-native`.
- **`example/`** — an Expo app that doubles as the integration-test harness for the module. It is **not published** and is not something a consumer of this package would set up.

The `example/ios/` and `example/android/` trees are gitignored — they're regenerated on each `npx expo prebuild`. The source-of-truth integration tests live under `example/tests/{ios,android}/` and are re-injected into each generated project by two example-app-only Expo config plugins:

- `example/plugins/with-ios-tests/` — copies the Swift test sources, registers an XCTest target in the Xcode project, and idempotently adds the corresponding CocoaPods test target stanza to the generated `Podfile`.
- `example/plugins/with-android-tests/` — copies the Kotlin test sources and adds the `androidTest` dependencies + instrumentation runner to the generated `app/build.gradle`.

Both plugins are registered in `example/app.json` and only run during `expo prebuild` of the **example app**. Consumers of `@comapeo/core-react-native` do not install or register them — they're internal to the example.

## Running tests

iOS:

- Fast, runs on macOS without a simulator: `cd ios && swift test` — exercises the framing, IPC, service lifecycle, and waitForFile helpers against mocks.
- Full integration with real Node.js mobile: `cd example && npx expo prebuild --platform ios && cd ios && pod install && xcodebuild test ...` — see `.github/workflows/ios-tests.yml` for the exact invocation.

Android:

- See `e2e/run-instrumented-tests.sh` for the local emulator-based run, and `.github/workflows/android-tests.yml` for CI.

Native binaries (downloaded on first use):

- `npm run download:nodejs-mobile` fetches `NodeMobile.xcframework` (iOS) and `libnode.so` per ABI + headers (Android) into the right places.
