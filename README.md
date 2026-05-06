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

This module can forward its lifecycle errors and (in later phases) RPC tracing
into the host app's `@sentry/react-native`. Sentry is opt-in — if you don't
register the plugin and don't import the sub-export, no Sentry code path is
exercised and no DSN ends up in your APK/IPA.

### 1. Register the Expo config plugin

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
        },
      }],
    ],
  },
};
```

The plugin runs at `expo prebuild` and bakes the DSN, environment, and other
options into AndroidManifest meta-data and Info.plist keys. Sourcing values
from `process.env` lets EAS build profiles produce different builds without
code changes — see `docs/sentry-integration-plan.md` §4.1 for the full pattern.

### 2. Hand off the host's Sentry SDK

```ts
import * as Sentry from "@sentry/react-native";
import { configureSentry } from "@comapeo/core-react-native/sentry";

Sentry.init({ /* options — DSN/environment/release auto-loaded from plist/manifest */ });

configureSentry({ sentry: Sentry });
```

After this call, the module's lifecycle ERROR transitions and `messageerror`
events are captured to your Sentry project tagged with the relevant phase
(`rootkey`, `starting-timeout`, `node-runtime-unexpected`, etc.). State
transitions show up as breadcrumbs that ride along on the next event.

### What gets captured automatically

Once the plugin is registered with a `dsn`, the module captures three
streams without any further setup:

- **JS-process events** (via the adapter you pass to `configureSentry`):
  state-machine ERROR transitions and `messageerror` parse failures
  tagged `proc:main`, `layer:rn`. State transitions emit breadcrumbs
  on every cycle.
- **FGS-process events** (Android only — `:ComapeoCore` foreground
  service): boot transaction (`comapeo.boot`) with phase spans
  (`boot.rootkey-load`, `boot.init-frame`), state-transition
  breadcrumbs, control-frame breadcrumbs, FGS-lifecycle breadcrumbs,
  watchdog-timeout events (`timeout:startup`, `timeout:fgsStop`),
  and rootkey-load `captureException` — all tagged `proc:fgs`,
  `layer:native` so the dashboard can split FGS-originated events
  from main-process events.
- **Backend-process events** (Phase 3, not yet shipped) — Node-side
  RPC method spans and exceptions tagged `proc:backend`.

The FGS-process Sentry SDK is initialised automatically in
`ComapeoCoreService.onCreate` from the manifest meta-data your
config plugin wrote. There's no extra configuration required for
multi-process Android apps using this module — that's the
`SentryFgsBridge` doing the work behind the scenes. If
`@sentry/react-native` isn't installed (so `io.sentry.*` isn't on
the runtime classpath), the bridge stays inert and the module
continues to function unchanged.

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
