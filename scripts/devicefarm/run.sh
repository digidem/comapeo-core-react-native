#!/usr/bin/env bash
# Run the Maestro e2e flow on AWS Device Farm real devices.
#
#   scripts/devicefarm/run.sh <app-release.apk> [smoke|low-end|<device-id,...>]
#
# Device Farm only exists in us-west-2. Artifacts land in .devicefarm/<run-id>/.
set -euo pipefail

export AWS_REGION=us-west-2 AWS_PAGER=""

PROJECT_NAME=comapeo-core-e2e
JOB_TIMEOUT_MINUTES=15

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

APK="${1:?usage: run.sh <app-release.apk> [smoke|low-end|<device-id,...>]}"
SELECTION="${2:-smoke}"

case "$SELECTION" in
  smoke) DEVICE_IDS="F1C3B0D61013491A8EE2FA19FAA80306" ;; # Pixel 3a, Android 10
  low-end)
    DEVICE_IDS="2EFF1E0D1C734B68A8F584C6CF9D617A" # LG Stylo 5, Android 9
    DEVICE_IDS+=",1DA66BB0A625454CBF96D3CDE68F818C" # Galaxy Tab A 10.1", Android 10, 32-bit
    DEVICE_IDS+=",D48BBC9AF1644AEFBAC7B431CAE21DD6" # Galaxy A13 5G, Android 11, 32-bit
    DEVICE_IDS+=",96552C5C5A6E4FC7820C6085622D5F03" # Redmi Note 10 5G, Android 11
    DEVICE_IDS+=",1BE3F573D4EC41F5A0AFC690CC800FD4" # Galaxy Tab A7 Lite, Android 13
    ;;
  *) DEVICE_IDS="$SELECTION" ;;
esac

log() { printf '\033[1m==> %s\033[0m\n' "$*" >&2; }

project_arn() {
  local arn
  arn=$(aws devicefarm list-projects \
    --query "projects[?name=='$PROJECT_NAME'].arn | [0]" --output text)
  if [[ "$arn" == "None" || -z "$arn" ]]; then
    arn=$(aws devicefarm create-project --name "$PROJECT_NAME" \
      --default-job-timeout-minutes "$JOB_TIMEOUT_MINUTES" \
      --query project.arn --output text)
  fi
  echo "$arn"
}

# create-upload, PUT the file, then wait for Device Farm's validation.
upload() {
  local project="$1" type="$2" file="$3" arn url status
  read -r arn url < <(aws devicefarm create-upload --project-arn "$project" \
    --name "$(basename "$file")" --type "$type" \
    --query '[upload.arn, upload.url]' --output text)
  curl -fsS -T "$file" "$url" >/dev/null
  while :; do
    status=$(aws devicefarm get-upload --arn "$arn" --query upload.status --output text)
    case "$status" in
      SUCCEEDED) break ;;
      FAILED)
        aws devicefarm get-upload --arn "$arn" --query upload.message --output text >&2
        return 1 ;;
    esac
    sleep 3
  done
  echo "$arn"
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# The Appium Node package type wants a zip holding an npm tarball; the spec
# unpacks it and only uses the flows inside.
mkdir -p "$WORK/pkg/flows"
cp "$ROOT/maestro/"*.yaml "$WORK/pkg/flows/"
printf '{"name":"comapeo-e2e-flows","version":"0.0.0"}\n' >"$WORK/pkg/package.json"
(cd "$WORK/pkg" && npm pack --silent --pack-destination "$WORK" >/dev/null)
(cd "$WORK" && zip -q flows.zip ./*.tgz)

PROJECT=$(project_arn)
log "Project $PROJECT"

log "Uploading app $(basename "$APK")"
APP_ARN=$(upload "$PROJECT" ANDROID_APP "$APK")
log "Uploading test package"
PKG_ARN=$(upload "$PROJECT" APPIUM_NODE_TEST_PACKAGE "$WORK/flows.zip")
log "Uploading test spec"
SPEC_ARN=$(upload "$PROJECT" APPIUM_NODE_TEST_SPEC "$HERE/testspec-android.yml")

DEVICE_ARNS=$(tr ',' '\n' <<<"$DEVICE_IDS" | sed 's/^/arn:aws:devicefarm:us-west-2::device:/' | jq -Rn '[inputs]')
SELECTION_JSON=$(jq -n --argjson arns "$DEVICE_ARNS" \
  '{filters: [{attribute: "ARN", operator: "IN", values: $arns}], maxDevices: ($arns | length)}')

log "Scheduling run on $(jq length <<<"$DEVICE_ARNS") device(s), ${JOB_TIMEOUT_MINUTES}m job timeout"
RUN_ARN=$(aws devicefarm schedule-run --project-arn "$PROJECT" \
  --name "e2e $(git -C "$ROOT" rev-parse --short HEAD) $SELECTION" \
  --app-arn "$APP_ARN" \
  --device-selection-configuration "$SELECTION_JSON" \
  --test "type=APPIUM_NODE,testPackageArn=$PKG_ARN,testSpecArn=$SPEC_ARN" \
  --execution-configuration "jobTimeoutMinutes=$JOB_TIMEOUT_MINUTES" \
  --query run.arn --output text)
log "Run $RUN_ARN"

while :; do
  read -r status counters < <(aws devicefarm get-run --arn "$RUN_ARN" \
    --query '[run.status, join(`/`, [to_string(run.completedJobs), to_string(run.totalJobs)])]' --output text)
  log "$status ($counters jobs done)"
  [[ "$status" == "COMPLETED" ]] && break
  sleep 30
done

OUT="$ROOT/.devicefarm/${RUN_ARN##*/}"
mkdir -p "$OUT"

aws devicefarm list-jobs --arn "$RUN_ARN" --output json |
  jq -r '.jobs[] | [.arn, .device.name, .device.os, .result, (.deviceMinutes.total // 0)] | @tsv' |
  while IFS=$'\t' read -r job name os result minutes; do
    printf '%-32s %-8s %-8s %s min\n' "$name" "$os" "$result" "$minutes"
    dir="$OUT/$(tr ' /"' '___' <<<"$name-$os")"
    mkdir -p "$dir"
    aws devicefarm list-artifacts --arn "$job" --type FILE --output json |
      jq -r '.artifacts[] | select(.type != "VIDEO") | [.name, .extension, .url] | @tsv' |
      while IFS=$'\t' read -r aname ext url; do
        curl -fsS -o "$dir/$(tr ' /' '__' <<<"$aname").$ext" "$url" || true
      done
  done

aws devicefarm get-run --arn "$RUN_ARN" \
  --query '{result: run.result, deviceMinutes: run.deviceMinutes}' --output json
log "Artifacts in $OUT"
