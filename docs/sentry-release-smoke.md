# Sentry release smoke test

Run before every release ([issue #69](https://github.com/digidem/comapeo-core-react-native/issues/69)).
Unit tests cover the Sentry *logic* (what a processor does when it runs);
this checklist covers the wiring they can't: whether spans actually reach
Sentry, with the right structure, from all three layers (React Native JS,
native Kotlin/Swift, and the embedded Node backend). Budget ~10 minutes of
verification after triggering the flows.

The "did anything arrive with the right shape" half is also scripted —
see [Scripted tripwire](#scripted-tripwire) below — but the UI-side checks
(breadcrumbs, duplicate init, eyeballing event JSON) stay manual.

## Setup

Build `apps/integration` (or `apps/e2e`) against the dedicated **test**
Sentry project, never the production one, so smoke traffic stays out of the
real dashboards and quota. In the app's `app.json`, the module's config
plugin block should look like:

```jsonc
[
  "../../app.plugin.js",
  {
    "sentry": {
      "dsn": "<test project DSN>",
      "environment": "smoke-2026-07-07", // distinctive per-run marker, see below
      "tracesSampleRate": 1.0,
      "diagnosticsEnabledDefault": true, // default, but be explicit
      "applicationUsageDataDefault": true,
      "debugDefault": true // per-RPC traces are debug-gated
    }
  }
]
```

- [ ] App built with the plugin pointing at the **test** project DSN.
- [ ] `environment` set to a distinctive per-run value (e.g.
      `smoke-YYYY-MM-DD`). There is no separate "test trace label" hook: the
      plugin's `environment` flows to the RN, native, and Node SDKs alike,
      so it uniquely marks every event from this build and is what the
      tripwire script polls for.
- [ ] Diagnostics on (`diagnosticsEnabledDefault` is `true` by default),
      `applicationUsageDataDefault: true`, and `debugDefault: true`. Without
      `debug`, RPC calls emit only metrics — no `rpc.client`/`rpc.server`
      spans. The `*Default` options only seed fresh installs, so uninstall
      first (or flip the toggles at runtime via `setDebugEnabled(true)` etc.
      and restart — the values are snapshotted at process start).
- [ ] Release build (`npm --prefix apps/integration run build:android` /
      `build:ios`) on a device or emulator/simulator.

## Trigger flows

- [ ] **Cold boot** — launch the app from the launcher (on Android this
      cold-starts the `:ComapeoCore` foreground service, the separate OS
      process that hosts Node).
- [ ] **One RPC call** — tap "Reload projects (warm listProjects)" in the
      integration app's *Sentry smoke* group (any `comapeo.*` call works).
- [ ] **Forced error** — tap "Capture RN-side exception" in the same group.

## Verify in Sentry (within ~10 minutes)

Filter everything by the run's `environment` value.

- [ ] **Boot trace** — a `comapeo.boot` transaction appears (Performance /
      Traces). The native transaction carries child spans `boot.fgs-launch`
      (Android; absent on iOS and on system-driven FGS restarts),
      `boot.extract-assets` (Android, first boot after an install/update
      only), `boot.node-spawn`, and `boot.rootkey-load`. The Node-side
      phases — `boot.loader-init` (with `boot.loader-import-sentry-node`
      and `boot.import-index`) and `boot.manager-init` — arrive as their
      own transactions on the **same trace**, nested under `boot.node-spawn`
      in the trace view. Node spans missing from the trace = cross-process
      stitching regression. (Shape reference:
      [sentry-integration.md §7.3.2](./sentry-integration.md).)
- [ ] **RPC trace** — the RPC produced a transaction with an `rpc.client`
      span (RN side) stitched to an `rpc.server` transaction (Node side) on
      one trace. Requires the `debug` toggle from Setup.
- [ ] **Error event** — the forced RN exception appears in Issues.
- [ ] `contexts.device.family == "Android"` on the FGS-emitted boot
      transaction, **not** `"Google"` (a `SentryFgsBridge` processor forces
      it; `"Google"` means the processor isn't installed).
- [ ] **iOS**: exactly one native-SDK init — no duplicate init signal in
      breadcrumbs/logs and no doubled events. The RN `Sentry.init` must run
      with `autoInitializeNativeSdk: false`; the native
      `AppLifecycleDelegate` owns `SentrySDK.start`.
- [ ] **Scope tags** on events from each layer: `proc` (`main` on iOS and
      the Android UI process, `fgs` in the Android service process),
      `layer` (`rn` / `native` / `node`), and `comapeo.rn` (module version
      label) everywhere.
- [ ] **No PII** in event JSON: no rootkey (base64) values, project IDs, or
      lat/lng coordinates — `[redacted]` placeholders are the scrubbers
      working as intended.
- [ ] `release` matches the build (`versionName+versionCode` by default)
      and `environment` matches the value set in Setup, on events from all
      three layers.

## Scripted tripwire

`scripts/sentry-tripwire.mjs` automates the arrival + structure assertions
(boot transaction, child spans, Node-side stitching, `device.family`,
tags, PII scan) against Sentry's API:

```bash
SENTRY_AUTH_TOKEN=... node scripts/sentry-tripwire.mjs \
  --org <org> --project <project> --environment smoke-2026-07-07
```

Run `node scripts/sentry-tripwire.mjs --help` for all options, or dispatch
the [`sentry-tripwire` workflow](../.github/workflows/sentry-tripwire.yml)
to run it from CI. The script polls for up to `--timeout` seconds (default
60), so it can be started right after the cold boot.
