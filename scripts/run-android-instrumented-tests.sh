#!/usr/bin/env bash
set -euo pipefail

# Driver for the Android instrumented test job. Lives in a file (rather
# than inline in the workflow) because reactivecircus/android-emulator-runner
# runs the workflow's `script:` line by line through `sh -c`, which breaks
# any multi-line construct (function definition, while loop, etc.).

# On snapshot restore, sys.boot_completed flips before system_server
# finishes binding settings/package/activity, so the next
# `adb shell settings put` can fail with "Broken pipe". Poll each service
# until it actually answers.
wait_for_emulator_services() {
  local deadline=$((SECONDS + 120))
  while (( SECONDS < deadline )); do
    local bc
    # tr -d '\r' because adb echoes CRLF.
    bc=$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')
    if [[ "$bc" == "1" ]] \
       && adb shell 'pm path android' >/dev/null 2>&1 \
       && adb shell 'cmd settings list global' >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "::error::Emulator services did not become ready within 120s" >&2
  adb shell getprop 2>/dev/null | grep -E 'boot|svc' >&2 || true
  return 1
}

wait_for_emulator_services

# disable-animations is left `false` so we drive the settings directly
# here; one retry covers a write-transaction race against first-time
# service init.
for s in window_animation_scale transition_animation_scale animator_duration_scale; do
  adb shell settings put global "$s" 0.0 \
    || { sleep 2; adb shell settings put global "$s" 0.0; }
done

# -i so a hanging test is identifiable from per-test STARTED/PASSED/FAILED.
cd apps/example/android
exec ./gradlew \
  :comapeo-core-react-native:connectedDebugAndroidTest \
  :app:connectedDebugAndroidTest \
  --no-daemon -i -PreactNativeArchitectures=x86_64
