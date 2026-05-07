import * as Sentry from "@sentry/react-native";

Sentry.init({
  dsn: "https://e2b12d102f24a786ed183bdcea143bf2@o4507148235702272.ingest.us.sentry.io/4511348559708160",
  environment: "development",
  enableLogs: true,
  tracesSampleRate: 1.0,
  debug: true,
  // Default `appStartIntegration` attaches the app-start span to the
  // first transaction the integration sees — typically a navigation
  // event. The example app has no navigation lib, so no host
  // transaction ever fires and the app-start data sits unflushed.
  // `standalone: true` makes the integration emit its own
  // transaction. Real consumers (comapeo-mobile, etc.) with
  // react-navigation can drop this override.
  integrations: (defaults) =>
    defaults.map((i) =>
      i.name === "AppStart" ? Sentry.appStartIntegration({ standalone: true }) : i,
    ),
});

import "@comapeo/core-react-native/sentry";

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
