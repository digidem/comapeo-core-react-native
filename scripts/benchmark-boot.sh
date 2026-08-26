#!/usr/bin/env bash
set -euo pipefail

# Cold-boot benchmark for the embedded Node backend on Android.
#
# Measures what the `:ComapeoCore` foreground-service process costs to start:
# peak RSS, settled RSS, the V8 heap breakdown, and launch → `started` →
# `ready` timings — all read from the module's `[comapeo.*]` lifecycle crumbs
# and the backend's own `[comapeo.memory] boot` log line, so no root is
# needed for the numbers. Built for comparing two builds of anything that
# changes the backend's footprint — a different libnode.so, a dependency
# bump, a lazy import — not for absolute numbers. Run --help for usage.

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
  cat <<'EOF'
Cold-boot benchmark for the embedded Node backend on Android.

Single series — measure whatever is installed (or install one APK first):
  ./scripts/benchmark-boot.sh --label before --iterations 10
  ./scripts/benchmark-boot.sh --label after --apk /tmp/after.apk
  node scripts/benchmark-report.mjs benchmark-results/before.json \
                                    benchmark-results/after.json

Interleaved A/B — alternates blocks between two APKs, which is the only
honest way to run this on a machine that is doing other work:
  ./scripts/benchmark-boot.sh --ab /tmp/before.apk /tmp/after.apk \
      --rounds 3 --per-round 5

Options:
  --label <name>        series label for a single-series run (default: current)
  --iterations <n>      boots in a single-series run (default: 5)
  --ab <a.apk> <b.apk>  interleaved A/B between two APKs
  --rounds <n>          A/B rounds (default: 3)
  --per-round <n>       boots per build per round (default: 5)
  --duration <s>        seconds to watch each boot (default: 20)
  --device <serial>     adb device (required when several are attached)
  --apk <path>          install this APK before the run
  --abi <abi>           ABI for the Release build (default: arm64-v8a)
  --out <dir>           results directory (default: benchmark-results)
  --skip-build          measure what is already installed

With no --apk/--ab it builds the integration app in Release first (debug
start-up is ~10x slower and not representative — see CONTRIBUTING.md).
EOF
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

# Run ids ("<label>-r<round>-<n>") reach the device shell unquoted, so keep
# every label to a safe character set.
safe_label() { printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_'; }
LABEL="$(safe_label "$LABEL")"

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

# The compile-cache wipe before each boot needs a root shell (app data dirs
# are private). Without it the wipe silently no-ops and measured boots are
# warm-cache, so say so up front instead of letting the run overclaim.
check_cache_wipe() {
  if "${ADB[@]}" shell 'id' 2>/dev/null | grep -q 'uid=0'; then
    echo "==> compile cache: wiped before each boot (cold-cache boots)"
  else
    echo "==> WARNING: adb shell is not root, so the compile-cache wipe is a no-op" >&2
    echo "    and measured boots are warm-cache. Run 'adb root' first (emulator or" >&2
    echo "    userdebug build) for the cold-cache boots docs/BENCHMARKING.md describes." >&2
  fi
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
  # not representative; measure after it. It only needs to reach `ready`
  # (~2s), not the memory sample, so don't watch it for the full duration.
  "${ADB[@]}" shell "sh /data/local/tmp/benchmark-sample.sh $PKG $ACTIVITY warmup 8" \
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
check_cache_wipe

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
  # "a" and "b", and fall back when both files share a basename.
  LABEL_A="$(safe_label "$(basename "$AB_A" .apk)")"
  LABEL_B="$(safe_label "$(basename "$AB_B" .apk)")"
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
# One raw directory per invocation: the documented before/after workflow is
# two invocations, and the second must not destroy the first's captures.
RAW_DIR="$OUT_DIR/raw/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$RAW_DIR"
if ! "${ADB[@]}" pull /data/local/tmp/comapeo-bench "$RAW_DIR" >/dev/null; then
  echo "Error: adb pull failed. The captures are still on the device under" >&2
  echo "/data/local/tmp/comapeo-bench — pull them manually and run" >&2
  echo "scripts/benchmark-collect.mjs against that directory." >&2
  exit 1
fi

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
