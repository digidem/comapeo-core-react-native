# CoMapeo Core React Native Testing App

## Running tests locally

1. Run `npm backend:build` in the project _root_.

2. Run `npm run android` or `npm run ios`

3. Press the `Run tests` button in the app.

## Notes for maintainers

- `jasmine-core` dep must be pinned to v5 because v6 introduces changes that Metro + Hermes cannot handle out of the box.
