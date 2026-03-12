#!/usr/bin/env bash
set -euo pipefail

# Downloads prebuilt nodejs-mobile binaries from GitHub releases.
#
# Android: libnode.so per ABI + Node.js headers → android/libnode/
# iOS:     NodeMobile.xcframework              → ios/NodeMobile.xcframework/
#
# Usage:
#   ./scripts/download-nodejs-mobile.sh                          # both platforms
#   ./scripts/download-nodejs-mobile.sh --platform android       # Android only
#   ./scripts/download-nodejs-mobile.sh --platform ios            # iOS only
#   ./scripts/download-nodejs-mobile.sh --platform all v18.20.4  # explicit version
#   NODEJS_MOBILE_VERSION=v18.20.4 ./scripts/...                 # via env var

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Parse arguments
PLATFORM="all"
VERSION=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform)
      PLATFORM="${2:-all}"
      shift 2
      ;;
    *)
      VERSION="$1"
      shift
      ;;
  esac
done

VERSION="${VERSION:-${NODEJS_MOBILE_VERSION:-v18.20.4}}"

# Normalize version tag
TAG="$VERSION"
[[ "$TAG" != v* ]] && TAG="v$TAG"
FILE_VERSION="${TAG#v}"

BASE_URL="https://github.com/nodejs-mobile/nodejs-mobile/releases/download/${TAG}"

download_android() {
  local LIBNODE_DIR="$PROJECT_ROOT/android/libnode"
  local MARKER_FILE="$LIBNODE_DIR/.version"
  local DOWNLOAD_URL="${BASE_URL}/nodejs-mobile-v${FILE_VERSION}-android.zip"
  local ZIP_FILE="/tmp/nodejs-mobile-android-${FILE_VERSION}.zip"

  echo "==> Android: nodejs-mobile ${TAG}"

  # Skip if already extracted with correct version
  if [ -f "$MARKER_FILE" ] && [ "$(cat "$MARKER_FILE")" = "$TAG" ]; then
    echo "    Already downloaded (${TAG}). Skipping."
    return
  fi

  # Download
  if [ -f "$ZIP_FILE" ]; then
    echo "    Using cached zip: $ZIP_FILE"
  else
    echo "    Downloading: $DOWNLOAD_URL"
    curl -fSL --retry 3 --retry-delay 5 -o "$ZIP_FILE" "$DOWNLOAD_URL"
  fi

  # Extract
  echo "    Extracting to $LIBNODE_DIR..."
  rm -rf "$LIBNODE_DIR"
  mkdir -p "$LIBNODE_DIR"
  unzip -q "$ZIP_FILE" -d "$LIBNODE_DIR"

  # Verify expected structure
  for abi in arm64-v8a armeabi-v7a x86_64; do
    if [ ! -f "$LIBNODE_DIR/bin/$abi/libnode.so" ]; then
      echo "Error: Expected $LIBNODE_DIR/bin/$abi/libnode.so not found"
      exit 1
    fi
  done

  if [ ! -f "$LIBNODE_DIR/include/node/node.h" ]; then
    echo "Error: Expected $LIBNODE_DIR/include/node/node.h not found"
    exit 1
  fi

  echo "$TAG" > "$MARKER_FILE"
  echo "    Android binaries ready (ABIs: arm64-v8a, armeabi-v7a, x86_64)"
}

download_ios() {
  local XCFRAMEWORK_DIR="$PROJECT_ROOT/ios/NodeMobile.xcframework"
  local MARKER_FILE="$XCFRAMEWORK_DIR/.version"
  local DOWNLOAD_URL="${BASE_URL}/nodejs-mobile-v${FILE_VERSION}-ios.zip"
  local ZIP_FILE="/tmp/nodejs-mobile-ios-${FILE_VERSION}.zip"

  echo "==> iOS: nodejs-mobile ${TAG}"

  # Skip if already extracted with correct version
  if [ -f "$MARKER_FILE" ] && [ "$(cat "$MARKER_FILE")" = "$TAG" ]; then
    echo "    Already downloaded (${TAG}). Skipping."
    return
  fi

  # Download
  if [ -f "$ZIP_FILE" ]; then
    echo "    Using cached zip: $ZIP_FILE"
  else
    echo "    Downloading: $DOWNLOAD_URL"
    curl -fSL --retry 3 --retry-delay 5 -o "$ZIP_FILE" "$DOWNLOAD_URL"
  fi

  # Extract — the zip contains a NodeMobile.xcframework directory at the top level
  echo "    Extracting to $XCFRAMEWORK_DIR..."
  rm -rf "$XCFRAMEWORK_DIR"
  mkdir -p "$PROJECT_ROOT/ios"

  # Extract to a temp dir first to handle the top-level directory in the zip
  local TEMP_DIR
  TEMP_DIR="$(mktemp -d)"
  unzip -q "$ZIP_FILE" -d "$TEMP_DIR"

  # The zip may contain NodeMobile.xcframework/ at top level or the contents directly
  if [ -d "$TEMP_DIR/NodeMobile.xcframework" ]; then
    mv "$TEMP_DIR/NodeMobile.xcframework" "$XCFRAMEWORK_DIR"
  else
    mv "$TEMP_DIR" "$XCFRAMEWORK_DIR"
  fi
  rm -rf "$TEMP_DIR"

  # Verify expected structure
  for lib_id in ios-arm64 ios-arm64_x86_64-simulator; do
    if [ ! -f "$XCFRAMEWORK_DIR/$lib_id/NodeMobile.framework/NodeMobile" ]; then
      echo "Error: Expected $XCFRAMEWORK_DIR/$lib_id/NodeMobile.framework/NodeMobile not found"
      exit 1
    fi
  done

  if [ ! -f "$XCFRAMEWORK_DIR/Info.plist" ]; then
    echo "Error: Expected $XCFRAMEWORK_DIR/Info.plist not found"
    exit 1
  fi

  echo "$TAG" > "$MARKER_FILE"
  echo "    iOS xcframework ready (device + simulator)"
}

case "$PLATFORM" in
  android)
    download_android
    ;;
  ios)
    download_ios
    ;;
  all)
    download_android
    download_ios
    ;;
  *)
    echo "Error: Unknown platform '$PLATFORM'. Use: android, ios, or all"
    exit 1
    ;;
esac

echo "==> Done."
