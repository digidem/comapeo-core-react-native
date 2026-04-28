import {
  androidPlatform,
  androidEmulator,
} from "@react-native-harness/platform-android";

const isCI = process.env.CI === "true";

/** @type {Partial<import('@react-native-harness/config').Config>} */
const config = {
  entryPoint: "./index.ts",
  appRegistryComponentName: "main",
  runners: [
    androidPlatform({
      name: "android",
      device: isCI
        ? androidEmulator("emulator-5554")
        : androidEmulator("Medium_Phone_API_36.1"),
      bundleId: "com.comapeo.core.example",
      activityName: ".MainActivity",
    }),
  ],
  defaultRunner: "android",
  // Uncomment when debugging
  // forwardClientLogs: true,
};

export default config;
