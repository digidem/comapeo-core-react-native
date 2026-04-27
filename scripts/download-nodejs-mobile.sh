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

PLATFORM="all"
VERSION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform) PLATFORM="${2:-all}"; shift 2 ;;
    *)          VERSION="$1"; shift ;;
  esac
done

VERSION="${VERSION:-${NODEJS_MOBILE_VERSION:-v18.20.4}}"
TAG="$VERSION"
[[ "$TAG" != v* ]] && TAG="v$TAG"
FILE_VERSION="${TAG#v}"
BASE_URL="https://github.com/nodejs-mobile/nodejs-mobile/releases/download/${TAG}"

# Downloads and extracts a release zip into the project tree.
#
# Args: name target_dir extract_into verify_file [exclude_pattern]
#   name             — "android" or "ios" (matches the URL slug + zip filename).
#   target_dir       — final destination; holds the .version marker.
#   extract_into     — where `unzip` writes. The two release zips have different
#                      layouts: the Android zip's top level is loose (`bin/`,
#                      `include/`) so we extract directly into `target_dir`;
#                      the iOS zip wraps its contents in `NodeMobile.xcframework/`
#                      so we extract into the parent and the wrapper becomes
#                      `target_dir`.
#   verify_file      — relative path under `target_dir` that must exist post-extract.
#   exclude_pattern  — optional `-x` pattern. The iOS zip also ships node-side
#                      headers under top-level `include/` that we don't need
#                      (the NodeMobile framework provides its own headers via
#                      its module.modulemap). Exclude them so the extra dir
#                      doesn't pollute the source tree.
download() {
  local name="$1" target="$2" extract_into="$3" verify="$4" exclude="${5:-}"
  local marker="$target/.version"

  if [ -f "$marker" ] && [ "$(cat "$marker")" = "$TAG" ]; then
    echo "==> $name: already $TAG, skipping"
    return
  fi

  local zip="/tmp/nodejs-mobile-${name}-${FILE_VERSION}.zip"
  if [ -f "$zip" ]; then
    echo "==> $name: using cached $zip"
  else
    echo "==> $name: downloading $TAG"
    curl -fSL --retry 3 --retry-delay 5 \
      -o "$zip" \
      "${BASE_URL}/nodejs-mobile-v${FILE_VERSION}-${name}.zip"
  fi

  rm -rf "$target"
  mkdir -p "$extract_into"
  if [ -n "$exclude" ]; then
    unzip -q "$zip" -d "$extract_into" -x "$exclude"
  else
    unzip -q "$zip" -d "$extract_into"
  fi

  if [ ! -e "$target/$verify" ]; then
    echo "Error: expected $target/$verify after extract" >&2
    exit 1
  fi

  echo "$TAG" > "$marker"
  echo "==> $name: $TAG ready"
}

ANDROID_TARGET="$PROJECT_ROOT/android/libnode"
IOS_TARGET="$PROJECT_ROOT/ios/NodeMobile.xcframework"

case "$PLATFORM" in
  android) download android "$ANDROID_TARGET" "$ANDROID_TARGET"   "include/node/node.h" ;;
  ios)     download ios     "$IOS_TARGET"     "$PROJECT_ROOT/ios" "Info.plist" "include/*" ;;
  all)
    download android "$ANDROID_TARGET" "$ANDROID_TARGET"   "include/node/node.h"
    download ios     "$IOS_TARGET"     "$PROJECT_ROOT/ios" "Info.plist" "include/*"
    ;;
  *)
    echo "Error: unknown platform '$PLATFORM'. Use: android, ios, or all" >&2
    exit 1
    ;;
esac

echo "==> Done."
