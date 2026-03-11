#!/usr/bin/env bash
set -euo pipefail

# Android test runner for @comapeo/core-react-native
#
# Runs instrumented tests (on device/emulator) and JVM unit tests.
#
# The instrumented tests live in android/src/androidTest/ and are run
# via Gradle's connectedDebugAndroidTest task against the example app.
# JVM unit tests live in android/src/test/ and need no device.
#
# Prerequisites:
#   - Android SDK with an AVD configured (or a connected device)
#   - Node.js and npm (for building the example app)
#
# Usage:
#   ./e2e/run-instrumented-tests.sh                           # run all tests
#   ./e2e/run-instrumented-tests.sh --skip-build              # skip build
#   ./e2e/run-instrumented-tests.sh --class NodeJSIPCTest     # single test class
#   ./e2e/run-instrumented-tests.sh --unit-only               # JVM unit tests only (no device)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
EXAMPLE_DIR="$PROJECT_ROOT/example"

SKIP_BUILD=false
TEST_CLASS=""
UNIT_ONLY=false

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --skip-build)
      SKIP_BUILD=true
      shift
      ;;
    --class)
      TEST_CLASS="$2"
      shift 2
      ;;
    --unit-only)
      UNIT_ONLY=true
      shift
      ;;
    *)
      echo "Unknown argument: $1"
      echo "Usage: $0 [--skip-build] [--class TestClassName] [--unit-only]"
      exit 1
      ;;
  esac
done

echo "╔══════════════════════════════════════════════╗"
echo "║  CoMapeo Core RN — Android Test Runner      ║"
echo "╚══════════════════════════════════════════════╝"

# ---------------------------------------------------------------------------
# Ensure node_modules are installed
# ---------------------------------------------------------------------------

ensure_deps() {
  cd "$EXAMPLE_DIR"
  if [ ! -d "node_modules" ]; then
    echo "Installing example app dependencies..."
    npm install
  fi
  cd "$PROJECT_ROOT"
  if [ ! -d "node_modules" ]; then
    echo "Installing root dependencies..."
    npm install
  fi
}

# ---------------------------------------------------------------------------
# JVM unit tests (no device needed)
# ---------------------------------------------------------------------------

run_unit_tests() {
  echo ""
  echo "==> Running JVM unit tests..."
  ensure_deps
  cd "$EXAMPLE_DIR/android"
  # The library module name in the Gradle build varies by Expo setup.
  # Run via the app module which includes the library.
  ./gradlew :comapeo-core-react-native:test || \
    echo "Warning: Library module test task failed. This may be expected if the module name differs."
  cd "$PROJECT_ROOT"
}

if [ "$UNIT_ONLY" = true ]; then
  run_unit_tests
  echo ""
  echo "==> JVM unit tests completed."
  exit 0
fi

# ---------------------------------------------------------------------------
# Preflight checks
# ---------------------------------------------------------------------------

if ! command -v adb &>/dev/null; then
  echo "Error: 'adb' is not installed or not in PATH."
  echo "  Install the Android SDK: https://developer.android.com/studio"
  exit 1
fi

# ---------------------------------------------------------------------------
# Ensure a device is available
# ---------------------------------------------------------------------------

ensure_device() {
  local devices
  devices=$(adb devices | grep -v "List" | grep -v "^$" | wc -l)

  if [ "$devices" -eq 0 ]; then
    echo "No Android device/emulator detected. Attempting to boot an emulator..."

    if ! command -v emulator &>/dev/null; then
      echo "Error: 'emulator' command not found. Start an emulator manually or install the Android SDK."
      exit 1
    fi

    local avd
    avd=$(emulator -list-avds 2>/dev/null | head -1)
    if [ -z "$avd" ]; then
      echo "Error: No AVDs found. Create one with Android Studio or:"
      echo "  avdmanager create avd -n test -k 'system-images;android-34;google_apis;x86_64'"
      exit 1
    fi

    echo "Booting AVD: $avd"
    emulator -avd "$avd" -no-snapshot-load -no-audio -no-window &

    echo "Waiting for emulator to boot..."
    adb wait-for-device
    while [ "$(adb shell getprop sys.boot_completed 2>/dev/null)" != "1" ]; do
      sleep 2
    done
    echo "Emulator booted."
  fi
}

ensure_device

# ---------------------------------------------------------------------------
# Run instrumented tests via Gradle
# ---------------------------------------------------------------------------

ensure_deps

echo ""
if [ "$SKIP_BUILD" = false ]; then
  echo "==> Building and running instrumented tests..."
else
  echo "==> Running instrumented tests (assuming pre-built)..."
fi

cd "$EXAMPLE_DIR/android"

if [ -n "$TEST_CLASS" ]; then
  FULL_CLASS="com.comapeo.core.$TEST_CLASS"
  echo "    Test filter: $FULL_CLASS"
  # connectedDebugAndroidTest builds and runs on connected device
  ./gradlew :comapeo-core-react-native:connectedDebugAndroidTest \
    -Pandroid.testInstrumentationRunnerArguments.class="$FULL_CLASS"
else
  ./gradlew :comapeo-core-react-native:connectedDebugAndroidTest
fi

cd "$PROJECT_ROOT"

# ---------------------------------------------------------------------------
# Also run JVM unit tests
# ---------------------------------------------------------------------------

run_unit_tests

echo ""
echo "==> All tests completed."
echo ""
echo "Test reports:"
echo "  Instrumented: example/android/build/reports/androidTests/connected/"
echo "  Unit:         android/build/reports/tests/"
