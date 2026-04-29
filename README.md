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
