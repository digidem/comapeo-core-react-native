#!/usr/bin/env bash
set -euo pipefail

# Cold-boot benchmark for the embedded Node backend on Android.
#
# Measures what the `:ComapeoCore` foreground-service process costs to start:
# peak RSS, settled RSS, PSS, the V8 heap breakdown, and launch → `started` →
# `ready` timings. Built for comparing two builds of anything that changes the
# backend's footprint — a different libnode.so, a dependency bump, a lazy
# import — not for absolute numbers.
#
# Two modes:
#
#   Single series — measure whatever is installed (or install one APK first):
#     ./scripts/benchmark-boot.sh --label before --iterations 10
#     ./scripts/benchmark-boot.sh --label after --apk /tmp/after.apk
#     node scripts/benchmark-report.mjs benchmark-results/before.json \
#                                       benchmark-results/after.json
#
#   Interleaved A/B — alternates blocks between two APKs, which is the only
#   honest way to run this on a machine that is doing other work:
#     ./scripts/benchmark-boot.sh --ab /tmp/before.apk /tmp/after.apk \
#         --rounds 3 --per-round 5
#
# With no --apk/--ab it builds the integration app in Release first (debug
# start-up is ~10x slower and not representative — see CONTRIBUTING.md).
#
# Peak RSS comes from the backend's own `[comapeo.memory] boot` log line,
# which reads /proc/self and so needs no root. `adb root` (available on
# emulators) additionally enables a 50 ms /proc timeline; without it the run
# is complete, just without the trajectory.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$PROJECT_ROOT/apps/integration"

PKG="com.comapeo.core.integration"
ACTIVITY=".MainActivity"
ABI="arm64-v8a"

LABEL="current"
ITERATIONS=5
DURATION=20
ROUNDS=3
PER_ROUND=5
DEVICE=""
APK=""
AB_A=""
AB_B=""
OUT_DIR="$PROJECT_ROOT/benchmark-results"
SKIP_BUILD=0

usage() {
  sed -n '3,30p' "$0" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --label)      LABEL="$2"; shift 2 ;;
    --iterations) ITERATIONS="$2"; shift 2 ;;
    --duration)   DURATION="$2"; shift 2 ;;
    --device)     DEVICE="$2"; shift 2 ;;
    --apk)        APK="$2"; shift 2 ;;
    --ab)
      [ $# -ge 3 ] || { echo "Error: --ab takes two APK paths." >&2; exit 1; }
      AB_A="$2"; AB_B="$3"; shift 3 ;;
    --rounds)     ROUNDS="$2"; shift 2 ;;
    --per-round)  PER_ROUND="$2"; shift 2 ;;
    --abi)        ABI="$2"; shift 2 ;;
    --out)        OUT_DIR="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    -h|--help)    usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

# The interactive shell aliases `adb` to a multi-device picker that ignores
# -s and blocks on stdin; go straight to the binary.
ADB=(command adb)
[ -n "$DEVICE" ] && ADB=(command adb -s "$DEVICE")

# ---------------------------------------------------------------
# Device
# ---------------------------------------------------------------

ensure_device() {
  command -v adb >/dev/null 2>&1 || {
    echo "Error: adb not found. Install Android platform-tools." >&2
    exit 1
  }
  local count
  count=$("${ADB[@]}" devices | grep -cE '\sdevice$' || true)
  if [ "$count" -eq 0 ]; then
    echo "Error: no device. Boot one first, e.g. 'emulator -avd Pixel_7a_API_34 &'." >&2
    exit 1
  fi
  if [ "$count" -gt 1 ] && [ -z "$DEVICE" ]; then
    echo "Error: $count devices attached; pass --device <serial>." >&2
    "${ADB[@]}" devices >&2
    exit 1
  fi
}

# /proc of another process is root-only. Best-effort: `adb root` succeeds on
# emulators and userdebug builds, fails harmlessly on a production device.
try_root() {
  if "${ADB[@]}" root >/dev/null 2>&1; then
    "${ADB[@]}" wait-for-device
    if "${ADB[@]}" shell 'id' 2>/dev/null | grep -q 'uid=0'; then
      echo "==> adb root: on (per-sample /proc timeline enabled)"
      return
    fi
  fi
  echo "==> adb root: unavailable (peak RSS still comes from the backend's own log line)"
}

# ---------------------------------------------------------------
# Build
# ---------------------------------------------------------------

build_release_apk() {
  echo "==> building apps/integration (Release, $ABI)"
  (cd "$APP_DIR/android" && ./gradlew :app:assembleRelease \
    "-PreactNativeArchitectures=$ABI" --console=plain -q)
  APK="$APP_DIR/android/app/build/outputs/apk/release/app-release.apk"
}

install_apk() {
  echo "==> installing $(basename "$1")"
  "${ADB[@]}" install -r "$1" >/dev/null
}

# ---------------------------------------------------------------
# Runs
# ---------------------------------------------------------------

run_boot() {
  local id="$1"
  printf '  %-24s' "$id"
  "${ADB[@]}" shell "sh /data/local/tmp/benchmark-sample.sh $PKG $ACTIVITY $id $DURATION" \
    | tr -d '\r'
}

# Runs $2 boots labelled "$1-r$3-<n>", discarding a warm-up first.
run_block() {
  local label="$1" count="$2" round="$3"
  # The first boot after an install faults the freshly written APK in and is
  # not representative; measure after it.
  "${ADB[@]}" shell "sh /data/local/tmp/benchmark-sample.sh $PKG $ACTIVITY warmup $DURATION" \
    >/dev/null 2>&1
  local i
  for i in $(seq 1 "$count"); do
    run_boot "$label-r$round-$i"
  done
}

# ---------------------------------------------------------------

echo "╔════════════════════════════════════════════╗"
echo "║  CoMapeo backend cold-boot benchmark       ║"
echo "╚════════════════════════════════════════════╝"

ensure_device
try_root

if [ -z "$APK" ] && [ -z "$AB_A" ] && [ "$SKIP_BUILD" -eq 0 ]; then
  build_release_apk
fi

mkdir -p "$OUT_DIR"
"${ADB[@]}" shell 'rm -rf /data/local/tmp/comapeo-bench'
"${ADB[@]}" push "$SCRIPT_DIR/lib/benchmark-sample.sh" \
  /data/local/tmp/benchmark-sample.sh >/dev/null
"${ADB[@]}" shell 'chmod 755 /data/local/tmp/benchmark-sample.sh'
# Animations skew the activity launch that starts the service. These are
# device-wide settings, so save what was there and put it back on the way out
# — including on Ctrl-C, which is how a long run usually ends.
ANIM_KEYS=(window_animation_scale transition_animation_scale animator_duration_scale)
ANIM_SAVED=()
for key in "${ANIM_KEYS[@]}"; do
  ANIM_SAVED+=("$("${ADB[@]}" shell "settings get global $key" 2>/dev/null | tr -d '\r' || true)")
done

restore_animations() {
  local i value
  for i in "${!ANIM_KEYS[@]}"; do
    value="${ANIM_SAVED[$i]}"
    if [ -z "$value" ] || [ "$value" = "null" ]; then
      value="1.0"
    fi
    "${ADB[@]}" shell "settings put global ${ANIM_KEYS[$i]} $value" >/dev/null 2>&1 || true
  done
}
trap restore_animations EXIT

for key in "${ANIM_KEYS[@]}"; do
  "${ADB[@]}" shell "settings put global $key 0" >/dev/null 2>&1 || true
done

if [ -n "$AB_A" ]; then
  # Label each series after its APK so the report names the builds rather than
  # "a" and "b". Run ids reach a device shell unquoted, so keep them to a safe
  # character set, and fall back when both files share a basename.
  safe_label() { printf '%s' "$(basename "$1" .apk)" | tr -c 'A-Za-z0-9._-' '_'; }
  LABEL_A="$(safe_label "$AB_A")"
  LABEL_B="$(safe_label "$AB_B")"
  if [ "$LABEL_A" = "$LABEL_B" ]; then LABEL_A="a-$LABEL_A"; LABEL_B="b-$LABEL_B"; fi

  echo "==> interleaved A/B: $ROUNDS rounds x $PER_ROUND boots per build"
  echo "    baseline  $LABEL_A  ($AB_A)"
  echo "    candidate $LABEL_B  ($AB_B)"
  for r in $(seq 1 "$ROUNDS"); do
    # Alternate which build goes first each round so a drift in host load
    # cannot line up with one of them.
    if [ $((r % 2)) -eq 1 ]; then
      order=("$LABEL_A|$AB_A" "$LABEL_B|$AB_B")
    else
      order=("$LABEL_B|$AB_B" "$LABEL_A|$AB_A")
    fi
    for entry in "${order[@]}"; do
      install_apk "${entry#*|}"
      run_block "${entry%%|*}" "$PER_ROUND" "$r"
    done
  done
  LABELS=("$LABEL_A" "$LABEL_B")
else
  [ -n "$APK" ] && install_apk "$APK"
  echo "==> $ITERATIONS boots, label '$LABEL'"
  run_block "$LABEL" "$ITERATIONS" 1
  LABELS=("$LABEL")
fi

echo "==> collecting"
RAW_DIR="$OUT_DIR/raw"
rm -rf "$RAW_DIR"
mkdir -p "$RAW_DIR"
"${ADB[@]}" pull /data/local/tmp/comapeo-bench "$RAW_DIR" >/dev/null 2>&1

for label in "${LABELS[@]}"; do
  node "$SCRIPT_DIR/benchmark-collect.mjs" \
    --raw "$RAW_DIR/comapeo-bench" \
    --label "$label" \
    --out "$OUT_DIR/$label.json"
done

echo
echo "==> results in $OUT_DIR"
if [ "${#LABELS[@]}" -eq 2 ]; then
  node "$SCRIPT_DIR/benchmark-report.mjs" \
    "$OUT_DIR/${LABELS[0]}.json" "$OUT_DIR/${LABELS[1]}.json"
else
  node "$SCRIPT_DIR/benchmark-report.mjs" "$OUT_DIR/${LABELS[0]}.json"
fi
