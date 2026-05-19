// Root babel config for jest only — the package build uses `tsc`
// directly (via `expo-module build`), so this doesn't affect the
// published artifacts. Jest's pipeline goes through `babel-jest`
// (configured by `jest-expo`'s preset) which needs a babel preset
// to handle TS imports from the test files under `src/__tests__/`.
//
// `apps/example` and `apps/e2e` have their own `babel.config.js`
// for Metro; this root config doesn't reach them (Metro resolves
// babel config from the per-app directory).

module.exports = {
  presets: ["babel-preset-expo"],
};
