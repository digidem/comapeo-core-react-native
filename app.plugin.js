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
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
const { withAndroidManifest } = configPlugins;
const { withMainApplication } = configPlugins;
const { withInfoPlist } = configPlugins;
const { withPodfile } = configPlugins;
const { withDangerousMod } = configPlugins;
const { withXcodeProject, IOSConfig } = configPlugins;
const require = createRequire(import.meta.url);
const {
  mergeContents,
} = require("@expo/config-plugins/build/utils/generateCode");

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

// Online map style URL the consuming app sets via `defaultOnlineStyleUrl`.
// Read by native (NodeJSService.{kt,swift}) and forwarded to the backend as
// the 5th argv positional; absent → backend falls back to its built-in URL.
const ANDROID_MAP_STYLE_URL_KEY = "com.comapeo.core.map.defaultOnlineStyleUrl";
const IOS_MAP_STYLE_URL_KEY = "ComapeoCoreDefaultOnlineStyleUrl";

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
  config = withSentryLibraryEvolution(config);
  // Optional default project config (presets/categories) supplied by the
  // consuming app. The module no longer ships @comapeo/default-categories;
  // when this prop is absent, new projects get no default config.
  config = withDefaultConfigAndroid(config, props?.defaultConfig);
  config = withDefaultConfigIos(config, props?.defaultConfig);
  // Optional online map style URL. Absent → the backend uses its built-in
  // default. Always passed through both mods so a `--no-clean` re-prebuild
  // after removing the prop strips the stale value.
  config = withDefaultOnlineStyleUrlAndroid(config, props?.defaultOnlineStyleUrl);
  config = withDefaultOnlineStyleUrlIos(config, props?.defaultOnlineStyleUrl);
  // The embedded map server serves tiles over cleartext HTTP on
  // loopback; release builds block cleartext by default. Permit it
  // for localhost only, on both platforms.
  config = withMapServerCleartextAndroid(config);
  config = withMapServerCleartextIos(config);
  // Skip React Native init in the headless `:ComapeoCore` backend process so its
  // cold start doesn't ANR before the foreground service can promote itself.
  config = withComapeoCoreProcessGuard(config);
  return config;
}

// Inject a guard at the top of the host app's MainApplication.onCreate so the
// headless `:ComapeoCore` backend process skips React Native init — running it
// there would delay the foreground service's startForeground() past Android's
// deadline and ANR the process on cold start. Detection and rationale live in
// the module's com.comapeo.core.ComapeoProcessGuard; this only splices the call.
const PROCESS_GUARD_MARKER = "comapeo-core-process-guard";
const PROCESS_GUARD_ANCHOR = "super.onCreate()";

const PROCESS_GUARD_KOTLIN = `
    // ${PROCESS_GUARD_MARKER}: the :ComapeoCore backend process (Node foreground
    // service, no UI) must not run React Native init — it would ANR the service on
    // cold start. See com.comapeo.core.ComapeoProcessGuard.
    if (com.comapeo.core.ComapeoProcessGuard.isBackendProcess(this)) {
      return
    }`;

function withComapeoCoreProcessGuard(config) {
  return withMainApplication(config, (cfg) => {
    const { language, contents } = cfg.modResults;
    if (contents.includes(PROCESS_GUARD_MARKER)) return cfg;
    // Hard-fail rather than warn-and-skip: a missed warning ships an app that
    // ANRs on first cold start of the backend process — far worse than a loud
    // prebuild failure the consumer must resolve.
    if (language !== "kt") {
      throw new Error(
        `@comapeo/core-react-native plugin: MainApplication is ${language}, not Kotlin. ` +
          "The :ComapeoCore process guard only supports a Kotlin MainApplication; " +
          "a Java MainApplication would cold-start the headless backend process with " +
          "full React Native init and ANR. Failing prebuild rather than shipping that.",
      );
    }
    const idx = contents.indexOf(PROCESS_GUARD_ANCHOR);
    if (idx === -1) {
      throw new Error(
        `@comapeo/core-react-native plugin: could not find \`${PROCESS_GUARD_ANCHOR}\` ` +
          "in MainApplication.kt to anchor the :ComapeoCore process guard. The generated " +
          "MainApplication template likely changed and the plugin must be updated. Failing " +
          "prebuild rather than silently shipping a cold-start ANR in the backend process.",
      );
    }
    const at = idx + PROCESS_GUARD_ANCHOR.length;
    cfg.modResults.contents =
      contents.slice(0, at) + PROCESS_GUARD_KOTLIN + contents.slice(at);
    return cfg;
  });
}

// Scoped to loopback so the rest of the app keeps the secure default
// (no cleartext to the public internet).
const ANDROID_NETWORK_SECURITY_CONFIG_RESOURCE =
  "comapeo_core_network_security_config";

const ANDROID_NETWORK_SECURITY_CONFIG_XML = `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by @comapeo/core-react-native. The embedded map server
     serves tiles over cleartext HTTP on loopback; permit cleartext for
     localhost only so the rest of the app keeps the secure default. -->
<network-security-config>
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="false">127.0.0.1</domain>
        <domain includeSubdomains="false">localhost</domain>
    </domain-config>
</network-security-config>
`;

function withMapServerCleartextAndroid(config) {
  config = withDangerousMod(config, [
    "android",
    async (cfg) => {
      const resXmlDir = join(
        cfg.modRequest.platformProjectRoot,
        "app/src/main/res/xml",
      );
      await mkdir(resXmlDir, { recursive: true });
      await writeFile(
        join(resXmlDir, `${ANDROID_NETWORK_SECURITY_CONFIG_RESOURCE}.xml`),
        ANDROID_NETWORK_SECURITY_CONFIG_XML,
      );
      return cfg;
    },
  ]);
  return withAndroidManifest(config, (cfg) => {
    const application = cfg.modResults.manifest.application?.[0];
    if (!application) {
      throw new Error(
        "@comapeo/core-react-native plugin: AndroidManifest.xml has no <application> element",
      );
    }
    application.$["android:networkSecurityConfig"] =
      `@xml/${ANDROID_NETWORK_SECURITY_CONFIG_RESOURCE}`;
    return cfg;
  });
}

// `NSAllowsLocalNetworking` lifts ATS for loopback/.local hosts only,
// leaving ATS enforced for the public internet.
function withMapServerCleartextIos(config) {
  return withInfoPlist(config, (cfg) => {
    const ats = cfg.modResults.NSAppTransportSecurity || {};
    ats.NSAllowsLocalNetworking = true;
    cfg.modResults.NSAppTransportSecurity = ats;
    return cfg;
  });
}

// Fixed on-device filename the native readers look for: Android extracts
// it from `assets/nodejs-project/` into the node project dir; iOS resolves
// it as a bundle resource. Native passes its resolved path to the backend
// as the `defaultConfigPath` argv positional.
const DEFAULT_CONFIG_FILENAME = "comapeo-default-config.comapeocat";

// Resolve the consumer's `defaultConfig` path (absolute, or relative to
// the app project root) and assert it exists — a typo'd path should fail
// prebuild loudly rather than silently ship no config.
function resolveDefaultConfigSource(modRequest, defaultConfig) {
  if (typeof defaultConfig !== "string" || defaultConfig.length === 0) {
    throw new Error(
      "@comapeo/core-react-native plugin: `defaultConfig` must be a path to a .comapeocat file",
    );
  }
  const abs = isAbsolute(defaultConfig)
    ? defaultConfig
    : join(modRequest.projectRoot, defaultConfig);
  if (!existsSync(abs)) {
    throw new Error(
      `@comapeo/core-react-native plugin: \`defaultConfig\` file not found: ${abs}`,
    );
  }
  return abs;
}

// Android: merge the config into the app's `assets/nodejs-project/` so it
// rides the existing asset→filesDir extraction the backend bundle already
// uses (assets have no fs path; the file needs one at runtime).
function withDefaultConfigAndroid(config, defaultConfig) {
  return withDangerousMod(config, [
    "android",
    async (cfg) => {
      const destDir = join(
        cfg.modRequest.platformProjectRoot,
        "app/src/main/assets/nodejs-project",
      );
      const dest = join(destDir, DEFAULT_CONFIG_FILENAME);
      if (defaultConfig == null) {
        // --no-clean re-prebuild after removing the prop: drop a stale copy.
        await rm(dest, { force: true });
        return cfg;
      }
      const src = resolveDefaultConfigSource(cfg.modRequest, defaultConfig);
      await mkdir(destDir, { recursive: true });
      await copyFile(src, dest);
      return cfg;
    },
  ]);
}

// iOS: copy the file into the app target's project directory and register
// it in Copy Bundle Resources so `Bundle.main` resolves it at runtime.
function withDefaultConfigIos(config, defaultConfig) {
  config = withDangerousMod(config, [
    "ios",
    async (cfg) => {
      const dest = join(
        cfg.modRequest.platformProjectRoot,
        cfg.modRequest.projectName,
        DEFAULT_CONFIG_FILENAME,
      );
      if (defaultConfig == null) {
        await rm(dest, { force: true });
        return cfg;
      }
      const src = resolveDefaultConfigSource(cfg.modRequest, defaultConfig);
      await copyFile(src, dest);
      return cfg;
    },
  ]);
  // Registration is add-only. `addResourceFileToGroup` is idempotent
  // (skips a file already in the group), so repeat prebuilds don't
  // duplicate the entry. We don't strip the entry when `defaultConfig`
  // is removed: `xcode`'s `removeResourceFile` throws on RN/Expo projects
  // (it assumes a `Resources` PBXGroup that doesn't exist here), and
  // hand-removing pbxproj sections is version-fragile. Removing the prop
  // therefore requires a clean prebuild (`expo prebuild --clean`) to drop
  // the stale reference; otherwise the build looks for a missing file.
  if (defaultConfig == null) return config;
  return withXcodeProject(config, (cfg) => {
    IOSConfig.XcodeUtils.addResourceFileToGroup({
      filepath: `${cfg.modRequest.projectName}/${DEFAULT_CONFIG_FILENAME}`,
      groupName: cfg.modRequest.projectName,
      project: cfg.modResults,
      isBuildFile: true,
      verbose: false,
    });
    return cfg;
  });
}

// Validate the consumer's `defaultOnlineStyleUrl` — a malformed URL should
// fail prebuild loudly rather than silently ship a broken style. `null`
// (prop absent) is allowed: native then forwards an empty slot and the
// backend uses its built-in default.
function normalizeStyleUrl(styleUrl) {
  if (styleUrl == null) return undefined;
  if (typeof styleUrl !== "string" || styleUrl.length === 0) {
    throw new Error(
      "@comapeo/core-react-native plugin: `defaultOnlineStyleUrl` must be a non-empty URL string",
    );
  }
  let parsed;
  try {
    parsed = new globalThis.URL(styleUrl);
  } catch {
    throw new Error(
      `@comapeo/core-react-native plugin: \`defaultOnlineStyleUrl\` is not a valid URL: ${styleUrl}`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `@comapeo/core-react-native plugin: \`defaultOnlineStyleUrl\` must be an http(s) URL: ${styleUrl}`,
    );
  }
  return styleUrl;
}

function withDefaultOnlineStyleUrlAndroid(config, styleUrl) {
  const url = normalizeStyleUrl(styleUrl);
  return withAndroidManifest(config, (cfg) => {
    const application = cfg.modResults.manifest.application?.[0];
    if (!application) {
      throw new Error(
        "@comapeo/core-react-native plugin: AndroidManifest.xml has no <application> element",
      );
    }
    application["meta-data"] = application["meta-data"] || [];
    syncAndroidMetaData(application, ANDROID_MAP_STYLE_URL_KEY, url);
    return cfg;
  });
}

function withDefaultOnlineStyleUrlIos(config, styleUrl) {
  const url = normalizeStyleUrl(styleUrl);
  return withInfoPlist(config, (cfg) => {
    setOrDelete(cfg.modResults, IOS_MAP_STYLE_URL_KEY, url);
    return cfg;
  });
}

// getsentry/sentry-cocoa#7950: Xcode 26's Swift compiler drops
// `SentrySDK.startTransaction` (and other Swift-only APIs) from the
// Sentry module unless the pod builds with library evolution.
// `SentryNativeBridge.swift` calls that API, so every consumer needs
// this. Inserted INSIDE the existing `post_install` block because
// CocoaPods allows only one `post_install` hook per Podfile.
const SENTRY_LIBRARY_EVOLUTION_HOOK = `\
    installer.pods_project.targets.each do |target|
      if target.name.start_with?('Sentry')
        target.build_configurations.each do |build_configuration|
          build_configuration.build_settings['BUILD_LIBRARY_FOR_DISTRIBUTION'] = 'YES'
        end
      end
    end`;

function withSentryLibraryEvolution(config) {
  return withPodfile(config, (cfg) => {
    cfg.modResults.contents = mergeContents({
      tag: "comapeo-core-sentry-library-evolution",
      src: cfg.modResults.contents,
      newSrc: SENTRY_LIBRARY_EVOLUTION_HOOK,
      anchor: /post_install do \|installer\|/,
      offset: 1,
      comment: "#",
    }).contents;
    return cfg;
  });
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
