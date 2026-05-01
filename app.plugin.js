// Expo config plugin for @comapeo/core-react-native.
//
// Phase 2 of the Sentry integration plan (see
// docs/sentry-integration-plan.md §4.1). The plugin runs at
// `expo prebuild` and writes the consumer's Sentry configuration
// into AndroidManifest.xml meta-data and Info.plist keys, where
// both `@sentry/react-native` (host-app's main process) and the
// embedded backend (Phase 3 — argv at Node spawn) can read them.
//
// When invoked without a `sentry` argument the plugin is a no-op:
// no manifest entries written, no plist keys written. Native
// treats absence as "Sentry off" (see SentryConfig.kt /
// SentryConfig.swift). The example app under apps/example/ ships
// unconfigured.
//
// `release` is intentionally NOT defaulted here — when omitted,
// the native readers build it from versionName + "+" + versionCode
// (Android) / CFBundleShortVersionString + "+" + CFBundleVersion
// (iOS) so successive EAS builds of the same marketing version
// produce distinct release tags.
//
// This file uses ESM syntax because the package's package.json
// declares `"type": "module"`. Expo's plugin resolver
// (`@expo/config-plugins`) reads `plugin.default ?? plugin`, so
// `export default` is the right shape.

// `@expo/config-plugins` is CommonJS; pull the named functions via the
// default-import-then-destructure dance Node ESM requires for CJS deps.
import configPlugins from "@expo/config-plugins";
const { withAndroidManifest, withInfoPlist } = configPlugins;

// Manifest meta-data names. Read by SentryConfig.kt via
// PackageManager.getApplicationInfo(...).metaData. Living on the
// main `<application>` tag means both the main process AND the
// `:ComapeoCore` FGS process see them — metaData is shared
// across processes within the package.
const ANDROID_KEYS = {
  dsn: "com.comapeo.core.sentry.dsn",
  environment: "com.comapeo.core.sentry.environment",
  release: "com.comapeo.core.sentry.release",
  sampleRate: "com.comapeo.core.sentry.sampleRate",
  tracesSampleRate: "com.comapeo.core.sentry.tracesSampleRate",
  rpcArgsBytes: "com.comapeo.core.sentry.rpcArgsBytes",
  captureApplicationDataDefault:
    "com.comapeo.core.sentry.captureApplicationDataDefault",
};

// Info.plist keys. Read by SentryConfig.swift via
// Bundle.main.infoDictionary. Prefixed with `ComapeoCore` to
// avoid collisions with `@sentry/react-native`'s own auto-config
// keys (`SentryDsn`, `SentryEnvironment`, …) — the host app's
// Sentry SDK reads its own values via its own plugin.
const IOS_KEYS = {
  dsn: "ComapeoCoreSentryDsn",
  environment: "ComapeoCoreSentryEnvironment",
  release: "ComapeoCoreSentryRelease",
  sampleRate: "ComapeoCoreSentrySampleRate",
  tracesSampleRate: "ComapeoCoreSentryTracesSampleRate",
  rpcArgsBytes: "ComapeoCoreSentryRpcArgsBytes",
  captureApplicationDataDefault:
    "ComapeoCoreSentryCaptureApplicationDataDefault",
};

function withComapeoCore(config, props) {
  // No Sentry config registered → plugin is a no-op. Both withX
  // helpers are skipped so we don't write empty meta-data /
  // plist entries that the native readers would have to
  // distinguish from "key present, empty string".
  if (!props || !props.sentry) {
    return config;
  }

  const sentry = normalizeSentryProps(props.sentry);

  config = withSentryAndroid(config, sentry);
  config = withSentryIos(config, sentry);
  return config;
}

function normalizeSentryProps(sentry) {
  if (typeof sentry !== "object" || sentry === null) {
    throw new Error(
      "@comapeo/core-react-native plugin: `sentry` must be an object",
    );
  }
  if (!sentry.dsn || typeof sentry.dsn !== "string") {
    throw new Error(
      "@comapeo/core-react-native plugin: `sentry.dsn` is required when sentry is configured. " +
        "Source it from EAS env vars in app.config.js, e.g. process.env.SENTRY_DSN.",
    );
  }
  if (!sentry.environment || typeof sentry.environment !== "string") {
    throw new Error(
      "@comapeo/core-react-native plugin: `sentry.environment` is required when sentry is configured. " +
        "Sourced per build profile via EAS env vars (see plan §4.1).",
    );
  }

  // Coerce values. Numbers, booleans → strings (manifest
  // meta-data and Info.plist values are string-typed in the
  // native readers; keeps both surfaces uniform).
  const normalized = {
    dsn: sentry.dsn,
    environment: sentry.environment,
  };
  if (sentry.release !== undefined) normalized.release = String(sentry.release);
  if (sentry.sampleRate !== undefined) {
    normalized.sampleRate = String(sentry.sampleRate);
  }
  if (sentry.tracesSampleRate !== undefined) {
    normalized.tracesSampleRate = String(sentry.tracesSampleRate);
  }
  if (sentry.rpcArgsBytes !== undefined) {
    normalized.rpcArgsBytes = String(sentry.rpcArgsBytes);
  }
  if (sentry.captureApplicationDataDefault !== undefined) {
    normalized.captureApplicationDataDefault = sentry.captureApplicationDataDefault
      ? "true"
      : "false";
  }
  return normalized;
}

function withSentryAndroid(config, sentry) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults;
    const application = manifest.manifest.application?.[0];
    if (!application) {
      throw new Error(
        "@comapeo/core-react-native plugin: AndroidManifest.xml has no <application> element",
      );
    }
    application["meta-data"] = application["meta-data"] || [];

    upsertAndroidMetaData(application, ANDROID_KEYS.dsn, sentry.dsn);
    upsertAndroidMetaData(
      application,
      ANDROID_KEYS.environment,
      sentry.environment,
    );
    syncAndroidMetaData(application, ANDROID_KEYS.release, sentry.release);
    syncAndroidMetaData(
      application,
      ANDROID_KEYS.sampleRate,
      sentry.sampleRate,
    );
    syncAndroidMetaData(
      application,
      ANDROID_KEYS.tracesSampleRate,
      sentry.tracesSampleRate,
    );
    syncAndroidMetaData(
      application,
      ANDROID_KEYS.rpcArgsBytes,
      sentry.rpcArgsBytes,
    );
    syncAndroidMetaData(
      application,
      ANDROID_KEYS.captureApplicationDataDefault,
      sentry.captureApplicationDataDefault,
    );

    return cfg;
  });
}

function syncAndroidMetaData(application, name, value) {
  if (value === undefined) {
    removeAndroidMetaData(application, name);
  } else {
    upsertAndroidMetaData(application, name, value);
  }
}

function upsertAndroidMetaData(application, name, value) {
  const list = application["meta-data"];
  const existing = list.find((m) => m.$?.["android:name"] === name);
  if (existing) {
    existing.$["android:value"] = value;
  } else {
    list.push({ $: { "android:name": name, "android:value": value } });
  }
}

function removeAndroidMetaData(application, name) {
  const list = application["meta-data"];
  const idx = list.findIndex((m) => m.$?.["android:name"] === name);
  if (idx !== -1) list.splice(idx, 1);
}

function withSentryIos(config, sentry) {
  return withInfoPlist(config, (cfg) => {
    const plist = cfg.modResults;
    plist[IOS_KEYS.dsn] = sentry.dsn;
    plist[IOS_KEYS.environment] = sentry.environment;
    setOrDelete(plist, IOS_KEYS.release, sentry.release);
    setOrDelete(plist, IOS_KEYS.sampleRate, sentry.sampleRate);
    setOrDelete(plist, IOS_KEYS.tracesSampleRate, sentry.tracesSampleRate);
    setOrDelete(plist, IOS_KEYS.rpcArgsBytes, sentry.rpcArgsBytes);
    setOrDelete(
      plist,
      IOS_KEYS.captureApplicationDataDefault,
      sentry.captureApplicationDataDefault,
    );
    return cfg;
  });
}

function setOrDelete(plist, key, value) {
  if (value === undefined) {
    delete plist[key];
  } else {
    plist[key] = value;
  }
}

export default withComapeoCore;
