// MUST be the first import. Forces RN's `setUpXHR` to register the
// `FormData` global before `expo/winter/runtime.native.ts` reads it
// at module load (Expo SDK 55 races on iOS + new arch + Hermes —
// https://github.com/expo/expo/issues/45313, fix landing upstream
// per https://github.com/expo/expo/commit/64597482).
import "react-native/Libraries/Core/InitializeCore";

import * as Sentry from "@sentry/react-native";
import { initSentry } from "@comapeo/core-react-native/sentry";

// DSN / release / environment / sampleRate / tracesSampleRate /
// enableLogs all flow through the Expo plugin in `app.json` (and
// `app.plugin.js`); the host doesn't pass them here. `initSentry`
// owns `Sentry.init` so the privacy toggles (`diagnosticsEnabled`,
// `applicationUsageData`) can gate the call in one place.
//
// The `integrations` extension hook receives the SDK defaults and
// returns the final list. Default `appStartIntegration` attaches the
// app-start span to the first transaction the integration sees —
// typically a navigation event. The example app has no navigation
// lib, so no host transaction ever fires and the app-start data
// sits unflushed. `standalone: true` makes the integration emit its
// own transaction. Real consumers (comapeo-mobile, etc.) with
// react-navigation can drop this override.
initSentry({
  integrations: (defaults) =>
    defaults.map((i) =>
      (i as { name?: string }).name === "AppStart"
        ? Sentry.appStartIntegration({ standalone: true })
        : i,
    ),
});

import { registerRootComponent } from "expo";

import App from "./App";

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately.
//
// `Sentry.wrap` is required for `app.start.cold` / `app.start.warm` to fire —
// it marks the app-start *end* timestamp on first render. Without it the
// AppStart integration drops the span with "Last recorded app start end
// timestamp is before the app start timestamp."
registerRootComponent(Sentry.wrap(App));
