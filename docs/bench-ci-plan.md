# Bench CI plan — manual dispatch + artifact storage

A first slice of CI integration for the `apps/benchmark/` UDS / RPC
bridge benchmark. This pass is intentionally narrow:

- **Trigger:** manual `workflow_dispatch` only.
- **Output:** the per-device NDJSON span files and the regenerated
  `RESULTS.md` autosummary block, uploaded as workflow artefacts.
- **Out of scope (deferred):** automated triggers (per-PR / nightly),
  regression detection, baseline storage, PR comments. Picking these up
  later is easier once the manual pipeline has run a few times and we
  know what the artefact shape settles into.

## What already exists locally

The end-to-end workflow runs cleanly from a developer machine today:

1. `cd apps/benchmark && npm run prebuild:bundle && (cd android && ./gradlew :app:assembleRelease)` — release APK with embedded JS.
2. `cd apps/benchmark && npm run ios:archive` — Development-export IPA. Reads `APPLE_DEVELOPMENT_TEAM_ID` from `.env`. Locally Xcode reads the developer cert from the user's login keychain (auto-provisioned when the user signed into Xcode with their Apple ID).
3. `npm run bench:browserstack -- --app-android <apk> --app-ios <ipa>` — uploads, dispatches against the curated 10 Android + 1 iOS device sweep, polls until terminal, pulls device logs, parses `BENCH_SPAN <json>` lines into `apps/benchmark/results/<slug>-<sid>.ndjson`.
4. `npm run bench:summarize` — rewrites the autosummary block in `apps/benchmark/RESULTS.md`.

The CI workflow is structurally a wrapper around steps 1–4 with the iOS keychain bootstrap and artefact upload added on either end.

## Workflow shape

`.github/workflows/bench.yml`, three jobs:

### `build-android` (ubuntu-latest, ~10 min)

Mirrors `android-tests.yml`'s caching pattern: `actions/setup-node` from `package.json`, JDK 17, `android-actions/setup-android`, the existing `android/libnode` cache keyed on `download-nodejs-mobile.sh`. Steps:

```
npm install --ignore-scripts
npm run download:nodejs-mobile  (cache miss only)
npm run backend:build
cd apps/benchmark && npm install --ignore-scripts && npm run prebuild:bundle
cd apps/benchmark && npx expo prebuild --platform android --no-install
cd apps/benchmark/android && ./gradlew :app:assembleRelease
```

Upload the APK as an intermediate artefact (1-day retention is fine).

### `build-ios` (macos-15, ~15-20 min)

Same Xcode 26.3 selection as `ios-tests.yml`. The build steps mirror the Android job up to `expo prebuild`, then:

```
cd apps/benchmark/ios && pod install
cd apps/benchmark && npm run ios:archive
```

iOS signing — the only meaningfully new piece — needs a temp keychain on the runner. CI runners start with empty keychains (unlike a local machine, where Xcode signed into the team's Apple ID auto-provisions the dev cert into `login.keychain-db`). Bootstrap:

1. Decode `APPLE_DEVELOPMENT_CERT_P12_BASE64` into a temp file.
2. `security create-keychain -p "$KEYCHAIN_PASSWORD" build.keychain`
3. `security default-keychain -s build.keychain && security unlock-keychain -p "$KEYCHAIN_PASSWORD" build.keychain && security set-keychain-settings -lut 7200 build.keychain`
4. `security import <p12> -k build.keychain -P "$APPLE_DEVELOPMENT_CERT_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security`
5. `security set-key-partition-list -S apple-tool:,apple: -s -k "$KEYCHAIN_PASSWORD" build.keychain` (suppresses the codesign UI prompt the first time it accesses the key on macOS 10.12+).

For `-allowProvisioningUpdates` to actually update profiles in CI, supply an App Store Connect API key (`APPLE_API_KEY_ID`, `APPLE_API_KEY_ISSUER`, `APPLE_API_KEY_BASE64`) — `xcodebuild` reads these from `~/.appstoreconnect/private_keys/`. Without the API key, the existing profile baked into the project is reused; that works as long as the cert hasn't expired and the profile hasn't been regenerated upstream.

Upload the IPA as an intermediate artefact.

### `run-bench` (ubuntu-latest, depends on both build jobs)

```
- download-artifact: APK
- download-artifact: IPA
- materialize .env from secrets (BROWSERSTACK_USERNAME, BROWSERSTACK_ACCESS_KEY, optional BENCH_BROWSERSTACK_PROJECT)
- npm install --ignore-scripts
- npm run bench:browserstack -- \
    --app-android <apk-path> \
    --app-ios <ipa-path> \
    --build-name comapeo-bench \
    --build-identifier ${{ github.run_id }} \
    --build-tag manual-${{ github.actor }}
- npm run bench:summarize
- upload-artifact (retention 30d):
    apps/benchmark/results/*.ndjson
    apps/benchmark/RESULTS.md
```

`timeout-minutes: 60` on the job — generous for the curated 10-device sweep on a healthy BS pool, fails clean if BS is saturated. No retry; a flaked dispatch is rerun by clicking "Re-run failed jobs" in the GH Actions UI.

## Inputs surface

`workflow_dispatch.inputs`:

- `devices_android` (string, optional) — CSV passthrough to `--devices-android`.
- `devices_ios` (string, optional) — CSV passthrough to `--devices-ios`.
- `build_tag` (string, default `manual`) — passthrough to `--build-tag` for filtering on the BS dashboard.

Defaults match the script's curated sweep.

## Required GitHub Secrets

| Secret | Purpose |
|---|---|
| `BROWSERSTACK_USERNAME` | BS Account → Settings → Access Keys |
| `BROWSERSTACK_ACCESS_KEY` | ditto |
| `APPLE_DEVELOPMENT_TEAM_ID` | 10-char team id (read by `apps/benchmark/scripts/build-ipa.sh`) |
| `APPLE_DEVELOPMENT_CERT_P12_BASE64` | `base64 < dev-cert.p12` of the developer cert + private key |
| `APPLE_DEVELOPMENT_CERT_PASSWORD` | the password set when exporting the .p12 |
| `KEYCHAIN_PASSWORD` | random — used only to lock/unlock the runner-local keychain |
| `APPLE_API_KEY_ID` (optional) | App Store Connect API key id |
| `APPLE_API_KEY_ISSUER` (optional) | App Store Connect issuer id |
| `APPLE_API_KEY_BASE64` (optional) | base64 of the .p8 file |
| `BENCH_BROWSERSTACK_PROJECT` (optional) | sticky BS project name (default: BS auto-creates) |

The Apple API key trio is optional — without it, the workflow uses the cached profile already in the project. If you ever need to regenerate the profile, you'll need to either rotate it in locally and commit, or supply the API key.

## Implementation order

1. Generate the dev cert .p12 from your login keychain (`Keychain Access → File → Export → p12`) and base64 it into `APPLE_DEVELOPMENT_CERT_P12_BASE64`. Store the export password in `APPLE_DEVELOPMENT_CERT_PASSWORD`.
2. Add the other secrets above.
3. Write `.github/workflows/bench.yml` with the three jobs.
4. Run via `Actions → Bench → Run workflow` on this branch first; iterate until green.
5. Merge to `main` (the workflow's `workflow_dispatch` trigger doesn't need anything on `main` to be available, but having it on `main` is the conventional home).

## Open questions to revisit later

- **Cost.** A full sweep is ~12 min wallclock × ~5 parallel device-min on BS plus ~25 min of CI runner time on the macOS job. Per-PR auto-trigger is the next decision; this plan defers it.
- **Regression detection.** Once we have a few runs of artefacts, decide whether baseline lives in-repo (`scripts/bench-baseline.json`) or only as historical artefacts.
- **iOS profile rotation.** If the team's Development cert expires, the cached profile breaks and the IPA build fails. Decide whether to supply the App Store Connect API key now (so `-allowProvisioningUpdates` re-fetches automatically) or accept manual rotation.
