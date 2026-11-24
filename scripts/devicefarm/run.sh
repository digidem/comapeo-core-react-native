#!/usr/bin/env bash
# Run the Maestro e2e flow on AWS Device Farm real devices.
#
#   DEVICEFARM_PROJECT_ARN=... scripts/devicefarm/run.sh <app-release.apk> [low-end|<device-id,...>]
#
# Devices default to $DEVICEFARM_DEVICE_IDS. Exits non-zero unless every device
# passes. Artifacts land in $DEVICEFARM_OUT_DIR (default .devicefarm/<run-id>/).
set -euo pipefail
shopt -s inherit_errexit

# Device Farm only exists in us-west-2.
export AWS_REGION=us-west-2 AWS_PAGER=""

JOB_TIMEOUT_MINUTES=15
RUN_DEADLINE_MINUTES="${DEVICEFARM_RUN_DEADLINE_MINUTES:-35}"
UPLOAD_DEADLINE_SECONDS=300

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

PROJECT="${DEVICEFARM_PROJECT_ARN:?set DEVICEFARM_PROJECT_ARN}"
APK="${1:?usage: run.sh <app-release.apk> [low-end|<device-id,...>]}"
SELECTION="${2:-${DEVICEFARM_DEVICE_IDS:-}}"
RUN_NAME="${DEVICEFARM_RUN_NAME:-e2e $(basename "$APK")}"

case "$SELECTION" in
  low-end)
    DEVICE_IDS="2EFF1E0D1C734B68A8F584C6CF9D617A"   # LG Stylo 5, Android 9
    DEVICE_IDS+=",1DA66BB0A625454CBF96D3CDE68F818C" # Galaxy Tab A 10.1", Android 10, 32-bit
    DEVICE_IDS+=",D48BBC9AF1644AEFBAC7B431CAE21DD6" # Galaxy A13 5G, Android 11, 32-bit
    DEVICE_IDS+=",79F9A58D576F4D2AB1A8AAF683201ADB" # Galaxy A14 5G, Android 13
    DEVICE_IDS+=",1BE3F573D4EC41F5A0AFC690CC800FD4" # Galaxy Tab A7 Lite, Android 13
    ;;
  "") echo "no devices: pass a selection or set DEVICEFARM_DEVICE_IDS" >&2; exit 2 ;;
  *) DEVICE_IDS="$SELECTION" ;;
esac

log() { printf '\033[1m==> %s\033[0m\n' "$*" >&2; }

WORK="$(mktemp -d)"
RUN_ARN=""
RUN_DONE=false

cleanup() {
  # A run left behind keeps billing devices until its job timeout.
  if [[ -n "$RUN_ARN" && "$RUN_DONE" != true ]]; then
    log "Stopping run $RUN_ARN"
    aws devicefarm stop-run --arn "$RUN_ARN" >/dev/null || true
  fi
  # Uploads are only safe to delete once no run is using them.
  if [[ -z "$RUN_ARN" || "$RUN_DONE" == true ]] && [[ -f "$WORK/uploads" ]]; then
    while read -r arn; do
      aws devicefarm delete-upload --arn "$arn" >/dev/null || true
    done <"$WORK/uploads"
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# create-upload, PUT the file, then wait for Device Farm's validation.
upload() {
  local type="$1" file="$2" arn url status deadline
  read -r arn url < <(aws devicefarm create-upload --project-arn "$PROJECT" \
    --name "$(basename "$file")" --type "$type" \
    --query '[upload.arn, upload.url]' --output text)
  [[ -n "$arn" && -n "$url" ]] || return 1
  echo "$arn" >>"$WORK/uploads"
  curl -fsS -T "$file" "$url" >/dev/null
  deadline=$((SECONDS + UPLOAD_DEADLINE_SECONDS))
  while ((SECONDS < deadline)); do
    status=$(aws devicefarm get-upload --arn "$arn" --query upload.status --output text)
    case "$status" in
      SUCCEEDED) echo "$arn"; return 0 ;;
      FAILED)
        aws devicefarm get-upload --arn "$arn" --query upload.message --output text >&2
        return 1 ;;
    esac
    sleep 3
  done
  echo "upload $file still $status after ${UPLOAD_DEADLINE_SECONDS}s" >&2
  return 1
}

DEVICE_ARNS=$(tr ',' '\n' <<<"$DEVICE_IDS" | sed 's/^/arn:aws:devicefarm:us-west-2::device:/' | jq -Rn '[inputs]')
DEVICE_COUNT=$(jq length <<<"$DEVICE_ARNS")
SELECTION_JSON=$(jq -n --argjson arns "$DEVICE_ARNS" \
  '{filters: [{attribute: "ARN", operator: "IN", values: $arns}], maxDevices: ($arns | length)}')

# Budget alerts lag billing by hours, so refuse up front rather than spend.
if [[ "${DEVICEFARM_TRIAL_ONLY:-}" == true ]]; then
  remaining=$(aws devicefarm get-account-settings \
    --query 'accountSettings.trialMinutes.remaining' --output text)
  [[ "$remaining" =~ ^[0-9.]+$ ]] || remaining=0
  needed=$((DEVICE_COUNT * JOB_TIMEOUT_MINUTES))
  if awk -v r="$remaining" -v n="$needed" 'BEGIN { exit !(r < n) }'; then
    echo "::error::Only $remaining Device Farm trial minutes left; this run could need $needed. Not scheduling." >&2
    exit 1
  fi
  log "$remaining trial minutes left"
fi

# The Appium Node package type wants a zip holding an npm tarball; the spec
# unpacks it and only uses the flow inside.
mkdir -p "$WORK/pkg/flows"
cp "$ROOT/maestro/e2e.yaml" "$WORK/pkg/flows/"
printf '{"name":"comapeo-e2e-flows","version":"0.0.0"}\n' >"$WORK/pkg/package.json"
(cd "$WORK/pkg" && npm pack --silent --pack-destination "$WORK" >/dev/null)
(cd "$WORK" && zip -q flows.zip ./*.tgz)

log "Uploading app $(basename "$APK")"
APP_ARN=$(upload ANDROID_APP "$APK")
log "Uploading test package"
PKG_ARN=$(upload APPIUM_NODE_TEST_PACKAGE "$WORK/flows.zip")
log "Uploading test spec"
SPEC_ARN=$(upload APPIUM_NODE_TEST_SPEC "$HERE/testspec-android.yml")

log "Scheduling \"$RUN_NAME\" on $DEVICE_COUNT device(s), ${JOB_TIMEOUT_MINUTES}m job timeout"
RUN_ARN=$(aws devicefarm schedule-run --project-arn "$PROJECT" \
  --name "$RUN_NAME" \
  --app-arn "$APP_ARN" \
  --device-selection-configuration "$SELECTION_JSON" \
  --test "type=APPIUM_NODE,testPackageArn=$PKG_ARN,testSpecArn=$SPEC_ARN" \
  --execution-configuration "jobTimeoutMinutes=$JOB_TIMEOUT_MINUTES,videoCapture=false" \
  --query run.arn --output text)
log "Run $RUN_ARN"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then echo "run_arn=$RUN_ARN" >>"$GITHUB_OUTPUT"; fi

# A retired device drops out of the selection silently; don't let the run pass
# with fewer (e.g. no 32-bit) devices than asked for.
MATCHED=$(aws devicefarm get-run --arn "$RUN_ARN" \
  --query run.deviceSelectionResult.matchedDevicesCount --output text)
if [[ "$MATCHED" != "$DEVICE_COUNT" ]]; then
  echo "only $MATCHED of $DEVICE_COUNT requested devices are available" >&2
  exit 1
fi

deadline=$((SECONDS + RUN_DEADLINE_MINUTES * 60))
failures=0
while :; do
  if ((SECONDS >= deadline)); then
    echo "run not finished after ${RUN_DEADLINE_MINUTES}m" >&2
    exit 1
  fi
  if ! state=$(aws devicefarm get-run --arn "$RUN_ARN" \
    --query '[run.status, run.completedJobs, run.totalJobs]' --output text); then
    ((++failures < 5)) || exit 1
    sleep 30
    continue
  fi
  failures=0
  read -r status done_jobs total_jobs <<<"$state"
  log "$status ($done_jobs/$total_jobs jobs done)"
  [[ "$status" == "COMPLETED" ]] && break
  sleep 30
done
RUN_DONE=true

OUT="${DEVICEFARM_OUT_DIR:-$ROOT/.devicefarm/${RUN_ARN##*/}}"
mkdir -p "$OUT"

aws devicefarm list-jobs --arn "$RUN_ARN" --output json |
  jq -r '.jobs[] | [.arn, .device.name, .device.os, .result, (.deviceMinutes.total // 0)] | @tsv' |
  while IFS=$'\t' read -r job name os result minutes; do
    printf '%-32s %-8s %-8s %s min\n' "$name" "$os" "$result" "$minutes"
    dir="$OUT/$(tr ' /"' '___' <<<"$name-$os")"
    mkdir -p "$dir"
    # Names repeat across the setup/test/teardown suites, so key files by ARN too.
    aws devicefarm list-artifacts --arn "$job" --type FILE --output json |
      jq -r '.artifacts[] | [.name, (.arn | split("/") | last), .extension, .url] | @tsv' |
      while IFS=$'\t' read -r aname aid ext url; do
        curl -fsS -o "$dir/$(tr ' /' '__' <<<"$aname")-$aid.$ext" "$url" || true
      done
  done

read -r result minutes < <(aws devicefarm get-run --arn "$RUN_ARN" \
  --query '[run.result, run.deviceMinutes.total]' --output text)
log "Result $result, $minutes device minutes. Artifacts in $OUT"
[[ "$result" == "PASSED" ]]
