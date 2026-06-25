import { registerRootComponent } from 'expo'
import { initSentry } from '@comapeo/core-react-native/sentry'

import App from './src/App'

// Wires the RN/Node/FGS Sentry scopes to the plugin-baked DSN so BrowserStack
// e2e runs forward RPC traces (createProject / getProject / deviceId / …). Must
// run before registerRootComponent; do NOT call Sentry.init directly —
// initSentry owns it. No-op if no DSN was baked in.
initSentry()

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App)
