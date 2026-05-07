import * as Sentry from "@sentry/react-native";

Sentry.init({
  dsn: "https://e2b12d102f24a786ed183bdcea143bf2@o4507148235702272.ingest.us.sentry.io/4511348559708160",
  environment: "development",
  enableLogs: true,
  tracesSampleRate: 1.0,
  debug: true,
});

import "@comapeo/core-react-native/sentry";

// Smoke-test marker — a known event we can look up in the Issues
// tab to confirm the integration is delivering end-to-end.
Sentry.captureMessage("comapeo-core-react-native example smoke test", "info");
Sentry.logger.info("comapeo example index.ts loaded", {
  smokeTest: true,
});

import { registerRootComponent } from "expo";

import App from "./App";

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
