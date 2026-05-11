#!/usr/bin/env bash
set -uo pipefail

# On snapshot restore, sys.boot_completed flips before system_server
# finishes binding settings/package/activity, so the next
# `adb shell settings put` can fail with "Broken pipe". Poll each service
# until it actually answers.
#
# -e intentionally omitted: an intermittent adb hiccup must not kill the
# probe — we want the loop to keep polling.

start=$SECONDS
deadline=$((start + 120))
# Negative seeds so the first iteration always logs.
last_report=-10
last_svc_dump=-30

while (( SECONDS < deadline )); do
  # tr -d '\r' because adb echoes CRLF.
  bc=$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')

  adb shell 'pm path android' >/dev/null 2>&1
  pm_rc=$?

  adb shell 'cmd settings list global' >/dev/null 2>&1
  cmd_rc=$?

  if [[ "$bc" == "1" && $pm_rc -eq 0 && $cmd_rc -eq 0 ]]; then
    echo "[wait-for-emulator] ready after $(( SECONDS - start ))s" >&2
    exit 0
  fi

  elapsed=$(( SECONDS - start ))

  if (( elapsed - last_report >= 10 )); then
    echo "[wait-for-emulator] t=${elapsed}s bc='${bc}' pm_rc=${pm_rc} cmd_rc=${cmd_rc}" >&2
    last_report=$elapsed
  fi

  if (( elapsed - last_svc_dump >= 30 )); then
    echo "[wait-for-emulator] init.svc.* snapshot at t=${elapsed}s:" >&2
    adb shell getprop 2>/dev/null | grep -E '^\[init\.svc\.' >&2 || true
    last_svc_dump=$elapsed
  fi

  sleep 1
done

echo "::error::Emulator services did not become ready within 120s" >&2
adb shell getprop 2>/dev/null | grep -E 'boot|svc' >&2 || true
exit 1
