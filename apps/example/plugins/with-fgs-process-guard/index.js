// Patches the example app's `MainApplication.kt` after `expo prebuild`
// to skip React Native initialisation in non-main processes (the
// `:ComapeoCore` FGS process). Without this guard, the FGS process
// runs the same RN autolink + bundle-bootstrap path that the main
// app does — adding hundreds of ms to `NodeJSService.start()`-side
// boot-time spans (`boot.fgs-launch`) without any payoff (the FGS
// hosts nodejs-mobile + a thin Kotlin lifecycle, no React surface).
//
// `apps/example/android/` is gitignored — this plugin runs as part
// of `expo prebuild` so the patch survives a clean prebuild.
//
// Experimental: this is currently scoped to the example app while we
// measure the improvement to `boot.fgs-launch` in the Sentry trace.
// If the savings hold up, the README §"Configure for Android" should
// recommend the same pattern for consumer apps.

const {
  withMainApplication,
} = require("@expo/config-plugins");
const {
  mergeContents,
} = require("@expo/config-plugins/build/utils/generateCode");

const PROCESS_GUARD_BODY = [
  "    // FGS-process guard: skip React Native init in non-main",
  "    // processes (`:ComapeoCore`). The autolink + JS-bundle",
  "    // bootstrap that `loadReactNative` triggers is irrelevant",
  "    // to the FGS process (it hosts nodejs-mobile + lifecycle",
  "    // only, no React surface) and adds hundreds of ms to the",
  "    // `boot.fgs-launch` Sentry span on cold start.",
  "    //",
  "    // `Application.getProcessName()` is API 28+. The example app",
  "    // targets API 36; consumer apps with lower minSdk should",
  "    // fall back to `ActivityManager.runningAppProcesses`.",
  "    if (android.os.Build.VERSION.SDK_INT >= 28 &&",
  "        android.app.Application.getProcessName() != packageName) {",
  "      return",
  "    }",
].join("\n");

function withFgsProcessGuard(config) {
  return withMainApplication(config, (cfg) => {
    if (cfg.modResults.language !== "kt") {
      throw new Error(
        "with-fgs-process-guard: expected MainApplication.kt, " +
          `got language=${cfg.modResults.language}. Patch the Java ` +
          "variant manually or extend this plugin.",
      );
    }

    // Insert the guard immediately after the `super.onCreate()` call
    // inside `override fun onCreate()`. The Expo SDK 55 template
    // emits that pattern verbatim; anchor on it directly.
    const { contents } = mergeContents({
      tag: "with-fgs-process-guard",
      src: cfg.modResults.contents,
      newSrc: PROCESS_GUARD_BODY,
      // `super.onCreate()` first appears inside the activity-free
      // Application.onCreate override; matching `super.onCreate()`
      // alone is enough because the file has exactly one
      // (the Application.onCreate body).
      anchor: /super\.onCreate\(\)/,
      offset: 1,
      comment: "//",
    });

    cfg.modResults.contents = contents;
    return cfg;
  });
}

module.exports = withFgsProcessGuard;
