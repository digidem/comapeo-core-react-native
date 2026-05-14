// Expo config plugin for @comapeo/core-react-native.
//
// Writes the consumer's Sentry configuration into AndroidManifest
// meta-data and Info.plist keys at `expo prebuild`. Native readers
// (SentryConfig.{kt,swift}) pick up the values; the embedded
// backend picks them up via Node argv.
//
// `@sentry/react-native` is a non-optional peer dep of this module,
// so the SDK is always present in the consumer's app. Whether
// Sentry actually emits is gated at runtime: absence of the `sentry`
// argument here means "Sentry installed but inert" — `initSentry()`
// returns early because no DSN was baked into the manifest /
// Info.plist.
//
// When invoked without a `sentry` argument the plugin actively
// REMOVES every key it owns (handles `--no-clean` re-prebuilds
// where stale entries from a previous run would otherwise survive).
//
// `release` is omitted from the plugin args by default — the
// native readers fall back to versionName+versionCode (Android) /
// CFBundleShortVersionString+CFBundleVersion (iOS) so successive
// EAS builds get distinct release tags.

// `@expo/config-plugins` is CommonJS; pull named functions via
// default-import-then-destructure (this package is ESM).
import configPlugins from "@expo/config-plugins";
import { createRequire } from "node:module";
const { withAndroidManifest } = configPlugins;
const { withInfoPlist } = configPlugins;
const require = createRequire(import.meta.url);

// Manifest meta-data on the main `<application>` tag is shared
// across processes within the package.
const ANDROID_KEYS = {
  dsn: "com.comapeo.core.sentry.dsn",
  environment: "com.comapeo.core.sentry.environment",
  release: "com.comapeo.core.sentry.release",
  sampleRate: "com.comapeo.core.sentry.sampleRate",
  tracesSampleRate: "com.comapeo.core.sentry.tracesSampleRate",
  rpcArgsBytes: "com.comapeo.core.sentry.rpcArgsBytes",
  diagnosticsEnabledDefault:
    "com.comapeo.core.sentry.diagnosticsEnabledDefault",
  captureApplicationDataDefault:
    "com.comapeo.core.sentry.captureApplicationDataDefault",
  enableLogs: "com.comapeo.core.sentry.enableLogs",
  // Identifies the @comapeo/core-react-native module build the FGS
  // process is running. Set on the FGS-side `sentry-android` scope
  // as the `comapeo.rn` tag and `comapeoBackend` context so FGS-
  // emitted captures (incl. Node-forwarded events) carry the same
  // module / backend-dep identification as RN-side events do via
  // `initSentry`.
  moduleVersion: "com.comapeo.core.module.version",
  backendModulesJson: "com.comapeo.core.backend.modules",
};

// Prefixed with `ComapeoCore` to avoid colliding with
// `@sentry/react-native`'s own keys (`SentryDsn`, etc.).
const IOS_KEYS = {
  dsn: "ComapeoCoreSentryDsn",
  environment: "ComapeoCoreSentryEnvironment",
  release: "ComapeoCoreSentryRelease",
  sampleRate: "ComapeoCoreSentrySampleRate",
  tracesSampleRate: "ComapeoCoreSentryTracesSampleRate",
  rpcArgsBytes: "ComapeoCoreSentryRpcArgsBytes",
  diagnosticsEnabledDefault:
    "ComapeoCoreSentryDiagnosticsEnabledDefault",
  captureApplicationDataDefault:
    "ComapeoCoreSentryCaptureApplicationDataDefault",
  enableLogs: "ComapeoCoreSentryEnableLogs",
};

function withComapeoCore(config, props) {
  // Always pass through both mods, even when Sentry is "off",
  // so a `--no-clean` re-prebuild after disabling Sentry strips
  // stale entries from the previous run rather than shipping
  // the old DSN.
  const sentry = props?.sentry ? normalizeSentryProps(props.sentry) : null;
  const moduleIdent = sentry ? readModuleIdentification() : null;
  config = withSentryAndroid(config, sentry, moduleIdent);
  config = withSentryIos(config, sentry);
  return config;
}

/**
 * Module version label + bundled-backend dep map — the same values
 * `src/version.ts` exposes to the RN-side `initSentry`. Used only on
 * Android: iOS is single-process and the RN-side global scope already
 * covers FGS-equivalent captures. Best-effort; failures fall back to
 * just the package.json `version` so a half-built dev checkout still
 * prebuilds.
 */
function readModuleIdentification() {
  let moduleVersion;
  try {
    moduleVersion = require("./build/version.js").COMAPEO_MODULE_VERSION_LABEL;
  } catch {
    try {
      moduleVersion = require("./package.json").version;
    } catch {
      return null;
    }
  }
  let backendModules = {};
  try {
    const backendPkg = require("./backend/package.json");
    backendModules = Object.fromEntries(
      Object.entries(backendPkg.dependencies ?? {}).filter(
        ([name]) =>
          name.startsWith("@comapeo/") || name === "@mapeo/crypto",
      ),
    );
  } catch {
    // Backend package.json missing — ship the version label without
    // the dep map. Better than failing prebuild.
  }
  return {
    moduleVersion,
    backendModulesJson: JSON.stringify(backendModules),
  };
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

  // Coerce numbers/booleans to strings — manifest meta-data and
  // Info.plist values are string-typed in the native readers.
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
  if (sentry.diagnosticsEnabledDefault !== undefined) {
    normalized.diagnosticsEnabledDefault = sentry.diagnosticsEnabledDefault
      ? "true"
      : "false";
  }
  if (sentry.captureApplicationDataDefault !== undefined) {
    normalized.captureApplicationDataDefault = sentry.captureApplicationDataDefault
      ? "true"
      : "false";
  }
  if (sentry.enableLogs !== undefined) {
    normalized.enableLogs = sentry.enableLogs ? "true" : "false";
  }
  return normalized;
}

function withSentryAndroid(config, sentry, moduleIdent) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults;
    const application = manifest.manifest.application?.[0];
    if (!application) {
      throw new Error(
        "@comapeo/core-react-native plugin: AndroidManifest.xml has no <application> element",
      );
    }
    application["meta-data"] = application["meta-data"] || [];

    if (sentry == null) {
      // Off: strip only the keys this plugin owns. Other plugins'
      // keys (e.g. `io.sentry.dsn` from @sentry/react-native) stay.
      for (const name of Object.values(ANDROID_KEYS)) {
        removeAndroidMetaData(application, name);
      }
      return cfg;
    }

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
      ANDROID_KEYS.diagnosticsEnabledDefault,
      sentry.diagnosticsEnabledDefault,
    );
    syncAndroidMetaData(
      application,
      ANDROID_KEYS.captureApplicationDataDefault,
      sentry.captureApplicationDataDefault,
    );
    syncAndroidMetaData(
      application,
      ANDROID_KEYS.enableLogs,
      sentry.enableLogs,
    );
    syncAndroidMetaData(
      application,
      ANDROID_KEYS.moduleVersion,
      moduleIdent?.moduleVersion,
    );
    syncAndroidMetaData(
      application,
      ANDROID_KEYS.backendModulesJson,
      moduleIdent?.backendModulesJson,
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

    if (sentry == null) {
      for (const key of Object.values(IOS_KEYS)) delete plist[key];
      return cfg;
    }

    plist[IOS_KEYS.dsn] = sentry.dsn;
    plist[IOS_KEYS.environment] = sentry.environment;
    setOrDelete(plist, IOS_KEYS.release, sentry.release);
    setOrDelete(plist, IOS_KEYS.sampleRate, sentry.sampleRate);
    setOrDelete(plist, IOS_KEYS.tracesSampleRate, sentry.tracesSampleRate);
    setOrDelete(plist, IOS_KEYS.rpcArgsBytes, sentry.rpcArgsBytes);
    setOrDelete(
      plist,
      IOS_KEYS.diagnosticsEnabledDefault,
      sentry.diagnosticsEnabledDefault,
    );
    setOrDelete(
      plist,
      IOS_KEYS.captureApplicationDataDefault,
      sentry.captureApplicationDataDefault,
    );
    setOrDelete(plist, IOS_KEYS.enableLogs, sentry.enableLogs);
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
