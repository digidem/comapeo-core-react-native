#!/usr/bin/env bash
set -euo pipefail

# Downloads prebuilt nodejs-mobile binaries for Android from GitHub releases.
#
# These binaries (libnode.so per ABI + Node.js headers) are required for the
# native CMake build. They are NOT checked into the repo due to size (~57MB).
#
# Usage:
#   ./scripts/download-nodejs-mobile.sh              # uses default version
#   ./scripts/download-nodejs-mobile.sh v18.20.4     # specific version
#   NODEJS_MOBILE_VERSION=v18.20.4 ./scripts/...     # via env var

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LIBNODE_DIR="$PROJECT_ROOT/android/libnode"

# Version can be overridden by argument or env var
VERSION="${1:-${NODEJS_MOBILE_VERSION:-v18.20.4}}"

# Strip leading 'v' for the filename but keep for the tag
TAG="$VERSION"
[[ "$TAG" != v* ]] && TAG="v$TAG"
FILE_VERSION="${TAG#v}"

DOWNLOAD_URL="https://github.com/nodejs-mobile/nodejs-mobile/releases/download/${TAG}/nodejs-mobile-v${FILE_VERSION}-android.zip"
ZIP_FILE="/tmp/nodejs-mobile-android-${FILE_VERSION}.zip"

echo "==> Downloading nodejs-mobile ${TAG} for Android..."
echo "    URL: $DOWNLOAD_URL"

# Skip download if already extracted with correct version
MARKER_FILE="$LIBNODE_DIR/.version"
if [ -f "$MARKER_FILE" ] && [ "$(cat "$MARKER_FILE")" = "$TAG" ]; then
  echo "    Already downloaded (${TAG}). Skipping."
  exit 0
fi

# Download
if [ -f "$ZIP_FILE" ]; then
  echo "    Using cached zip: $ZIP_FILE"
else
  curl -fSL --retry 3 --retry-delay 5 -o "$ZIP_FILE" "$DOWNLOAD_URL"
fi

# Extract into android/libnode/
echo "==> Extracting to $LIBNODE_DIR..."
rm -rf "$LIBNODE_DIR"
mkdir -p "$LIBNODE_DIR"

# The zip contains bin/ and include/ at the top level
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

# Write version marker
echo "$TAG" > "$MARKER_FILE"

echo "==> nodejs-mobile ${TAG} Android binaries ready."
echo "    ABIs: arm64-v8a, armeabi-v7a, x86_64"
echo "    Path: $LIBNODE_DIR"
