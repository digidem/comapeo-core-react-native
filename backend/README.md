# Backend for `@comapeo/core-react-native`

Location for code that sets up `@comapeo/core` in nodejs-mobile and makes it accessible for the React Native client.

## Deps overrides

### `@hyperswarm/secret-stream`

Later version introduces sodium-native@5, which we don't yet have prebuilds for.

### `fs-native-extensions`

Needs to match version that we have native prebuilds for.

### `mirror-drive`

Later versions introduce another native dep that we don't yet have prebuilds for ([rabin-native](https://github.com/holepunchto/rabin-native))

### `require-addon`

Later version introduces changes to resolution logic that caused our native modules not to be found.

### `simdle-native`

Needs to match version that we have native prebuilds for.
