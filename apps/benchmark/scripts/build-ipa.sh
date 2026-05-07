#!/usr/bin/env bash
#
# Build a Development-export IPA of the bench app, ready to upload to
# BrowserStack. Requires:
#
#   - Apple Developer Program membership (paid)
#   - The bundle id `com.comapeo.core.benchmark` registered in your
#     team's Identifiers list at https://developer.apple.com/account/
#     resources/identifiers/list
#   - Xcode signed in with that developer account so it can auto-create
#     a Development provisioning profile + signing certificate on first
#     archive
#   - APPLE_DEVELOPMENT_TEAM_ID in .env (10-char team identifier;
#     visible at the top right of the developer portal page)
#
# BrowserStack auto-resigns iOS apps on upload, so a Development-export
# IPA works there without registering BS device UDIDs ourselves.
#
# Usage:
#   apps/benchmark/scripts/build-ipa.sh [out-dir]
#
# Default output dir: apps/benchmark/ios-build/. Final IPA path is
# printed at the end and consumable by `--app-ios <path>`.

set -euo pipefail

# --- arg + env validation -----------------------------------------------

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
BENCH_DIR="$REPO_ROOT/apps/benchmark"
OUT_DIR="${1:-$BENCH_DIR/ios-build}"

# Auto-source .env so APPLE_DEVELOPMENT_TEAM_ID propagates.
if [[ -f "$REPO_ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$REPO_ROOT/.env"
  set +a
fi

if [[ -z "${APPLE_DEVELOPMENT_TEAM_ID:-}" ]]; then
  echo "error: APPLE_DEVELOPMENT_TEAM_ID not set." >&2
  echo "  Add it to .env (10-char team id from https://developer.apple.com/account/)." >&2
  exit 1
fi

if ! command -v xcodebuild >/dev/null; then
  echo "error: xcodebuild not on PATH. Install Xcode + Command Line Tools." >&2
  exit 1
fi

# --- prebuild --------------------------------------------------------------

echo "==> staging bench bundle + iOS prebuild"
cd "$BENCH_DIR"
npm run prebuild:bundle
# Skip pod install here; the archive step runs its own against the fresh Podfile.
npx expo prebuild --no-install --platform ios

cd "$BENCH_DIR/ios"
echo "==> pod install"
pod install --silent

# --- archive ---------------------------------------------------------------

# Workspace + scheme are the slug Expo sanitises from app.json.
WORKSPACE="$(ls -d ./*.xcworkspace | head -1)"
SCHEME="$(basename "$WORKSPACE" .xcworkspace)"

if [[ -z "$WORKSPACE" || -z "$SCHEME" ]]; then
  echo "error: couldn't locate .xcworkspace under $BENCH_DIR/ios" >&2
  exit 1
fi

ARCHIVE_PATH="$OUT_DIR/$SCHEME.xcarchive"
IPA_DIR="$OUT_DIR/ipa"

mkdir -p "$OUT_DIR"
rm -rf "$ARCHIVE_PATH" "$IPA_DIR"

echo "==> archiving ($SCHEME / Release / generic iOS device)"
xcodebuild archive \
  -workspace "$WORKSPACE" \
  -scheme "$SCHEME" \
  -configuration Release \
  -destination "generic/platform=iOS" \
  -archivePath "$ARCHIVE_PATH" \
  DEVELOPMENT_TEAM="$APPLE_DEVELOPMENT_TEAM_ID" \
  -allowProvisioningUpdates \
  | tail -20

# --- export ---------------------------------------------------------------

# Inline plist so the team id flows in per-dev. BS accepts any non-App-Store method.
EXPORT_PLIST="$OUT_DIR/ExportOptions.plist"
cat > "$EXPORT_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>development</string>
  <key>teamID</key>
  <string>$APPLE_DEVELOPMENT_TEAM_ID</string>
  <key>signingStyle</key>
  <string>automatic</string>
  <key>stripSwiftSymbols</key>
  <true/>
  <key>thinning</key>
  <string>&lt;none&gt;</string>
</dict>
</plist>
EOF

echo "==> exporting IPA"
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportPath "$IPA_DIR" \
  -exportOptionsPlist "$EXPORT_PLIST" \
  -allowProvisioningUpdates \
  | tail -10

IPA="$(ls "$IPA_DIR"/*.ipa | head -1)"
if [[ -z "$IPA" ]]; then
  echo "error: no .ipa produced under $IPA_DIR" >&2
  exit 1
fi

echo ""
echo "==> done"
echo "  IPA: $IPA"
echo ""
echo "Next: npm run bench:browserstack -- --app-ios \"$IPA\""
