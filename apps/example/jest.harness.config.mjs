/** @type {import('jest').Config} */
const config = {
  preset: "react-native-harness",
  testMatch: ["<rootDir>/tests/react-native/**/*.harness.[jt]s?(x)"],
};

export default config;
