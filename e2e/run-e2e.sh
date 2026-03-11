#!/usr/bin/env bash
set -euo pipefail

# E2E test runner for @comapeo/core-react-native
# Builds the example app, boots an emulator if needed, installs the APK, and runs Maestro flows.
#
# Prerequisites:
#   - Android SDK with an AVD configured (or a connected device)
#   - Maestro CLI installed (https://maestro.mobile.dev)
#   - Node.js and npm
#
# Usage:
#   ./e2e/run-e2e.sh              # build + run all tests
#   ./e2e/run-e2e.sh --skip-build # skip build, run tests only
#   ./e2e/run-e2e.sh <flow.yaml>  # run a single flow

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
EXAMPLE_DIR="$PROJECT_ROOT/example"
MAESTRO_DIR="$SCRIPT_DIR/.maestro"
APK_PATH="$EXAMPLE_DIR/android/app/build/outputs/apk/release/app-release.apk"
DEBUG_APK_PATH="$EXAMPLE_DIR/android/app/build/outputs/apk/debug/app-debug.apk"
PACKAGE_NAME="com.comapeo.core.example"

SKIP_BUILD=false
SINGLE_FLOW=""

# Parse arguments
for arg in "$@"; do
  case $arg in
    --skip-build)
      SKIP_BUILD=true
      ;;
    *.yaml)
      SINGLE_FLOW="$arg"
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Preflight checks
# ---------------------------------------------------------------------------

check_command() {
  if ! command -v "$1" &>/dev/null; then
    echo "Error: '$1' is not installed or not in PATH."
    echo "  Install instructions: $2"
    exit 1
  fi
}

check_command "adb" "https://developer.android.com/studio"
check_command "maestro" "https://maestro.mobile.dev/getting-started/installing-maestro"

# ---------------------------------------------------------------------------
# Ensure an emulator is running or a device is connected
# ---------------------------------------------------------------------------

ensure_device() {
  local devices
  devices=$(adb devices | grep -v "List" | grep -v "^$" | wc -l)

  if [ "$devices" -eq 0 ]; then
    echo "No Android device/emulator detected. Attempting to boot an emulator..."

    local avd
    avd=$(emulator -list-avds 2>/dev/null | head -1)
    if [ -z "$avd" ]; then
      echo "Error: No AVDs found. Create one with Android Studio or:"
      echo "  avdmanager create avd -n test -k 'system-images;android-34;google_apis;x86_64'"
      exit 1
    fi

    echo "Booting AVD: $avd"
    emulator -avd "$avd" -no-snapshot-load -no-audio -no-window &
    EMULATOR_PID=$!

    echo "Waiting for emulator to boot..."
    adb wait-for-device
    # Wait for boot animation to finish
    while [ "$(adb shell getprop sys.boot_completed 2>/dev/null)" != "1" ]; do
      sleep 2
    done
    echo "Emulator booted."
  fi
}

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

build_app() {
  echo "==> Building example app..."
  cd "$EXAMPLE_DIR"

  # Install dependencies if needed
  if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
  fi

  # Build debug APK (faster, doesn't need signing)
  npx expo run:android --variant debug --no-install

  cd "$PROJECT_ROOT"
}

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------

install_app() {
  local apk=""
  if [ -f "$DEBUG_APK_PATH" ]; then
    apk="$DEBUG_APK_PATH"
  elif [ -f "$APK_PATH" ]; then
    apk="$APK_PATH"
  else
    echo "Error: No APK found. Run without --skip-build first."
    exit 1
  fi

  echo "==> Installing APK: $apk"
  adb install -r "$apk"
}

# ---------------------------------------------------------------------------
# Run tests
# ---------------------------------------------------------------------------

run_tests() {
  if [ -n "$SINGLE_FLOW" ]; then
    local flow_path="$SINGLE_FLOW"
    # Resolve relative paths against MAESTRO_DIR
    if [ ! -f "$flow_path" ]; then
      flow_path="$MAESTRO_DIR/$SINGLE_FLOW"
    fi
    echo "==> Running single flow: $flow_path"
    maestro test "$flow_path"
  else
    echo "==> Running all Maestro flows in $MAESTRO_DIR"
    maestro test "$MAESTRO_DIR"
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

echo "╔══════════════════════════════════════╗"
echo "║  CoMapeo Core RN — E2E Test Runner  ║"
echo "╚══════════════════════════════════════╝"

ensure_device

if [ "$SKIP_BUILD" = false ]; then
  build_app
fi

install_app
run_tests

echo ""
echo "==> All e2e tests completed."
